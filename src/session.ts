import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  command,
  COMMAND_NAMES,
  DIFFICULTIES,
  displayPath,
  isCommandName,
  isDifficulty,
  step,
  toCodeWrite,
} from './engine.ts';
import type { CommandName, CommandOutcome, ProjectRoot, RawWrite, ScaffoldCheck } from './engine.ts';
import { ENDED, relay, renderCommand, renderReady, renderRegisterRefusal, renderStatus, renderWriteDenial } from './messages.ts';
import type { Vocab } from './messages.ts';
import { openStore, stateDir } from './store.ts';
import type { Store } from './store.ts';

export type WriteVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface CommandReply {
  readonly kind: CommandOutcome['kind'];
  readonly text: string;
}

export interface ToolReply {
  readonly ok: boolean;
  readonly text: string;
}

export interface SpotMe {
  readonly root: ProjectRoot;
  readonly store: Store;
  /** Fails open: any error allows the write and logs to stderr. */
  onWrite(raws: readonly RawWrite[]): Promise<WriteVerdict>;
  command(name: CommandName, args: string): Promise<CommandReply>;
  /** What `command` would answer, from a lock-free snapshot, without changing state. */
  peekCommand(name: CommandName, args: string): Promise<CommandOutcome['kind']>;
  callTool(name: string, args: unknown): Promise<ToolReply>;
}

export interface SpotMeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: Store;
  readonly log?: (line: string) => void;
}

export type ParamSpec =
  | { readonly type: 'string'; readonly description: string; readonly optional?: true }
  | { readonly type: 'enum'; readonly values: readonly string[]; readonly description: string; readonly optional?: true };

export interface ToolSpec {
  readonly description: string;
  readonly params: Readonly<Record<string, ParamSpec>>;
}

export const TOOLS = {
  spotme_exercise: {
    description: 'Record the start of a SpotMe coding exercise. Call this AFTER writing the scaffold file with its SPOTME: marker.',
    params: {
      unit: { type: 'string', description: "Name of the unit being exercised (e.g. 'UserAuth.login')" },
      filePath: { type: 'string', description: 'Path to the scaffold file (already written to disk)' },
      difficulty: { type: 'enum', values: DIFFICULTIES, description: 'Difficulty, must match the active session setting' },
    },
  },
  spotme_status: { description: 'Show the current SpotMe session status.', params: {} },
  spotme_end: {
    description: 'Close the current SpotMe exercise. Call this as the LAST thing after done, solve, or skip.',
    params: {},
  },
  spotme_command: {
    description:
      'Run a SpotMe slash command (on, off, status, done, hint, solve, skip, rep) and follow the returned instructions exactly.',
    params: {
      name: { type: 'enum', values: COMMAND_NAMES, description: 'Command name without the /spotme: prefix' },
      args: { type: 'string', description: 'Text the user typed after the command', optional: true },
    },
  },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOLS;

export function toJsonSchema(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(spec.params)) {
    properties[name] =
      p.type === 'enum' ? { type: 'string', enum: [...p.values], description: p.description } : { type: 'string', description: p.description };
    if (!p.optional) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function parseArgs(spec: ToolSpec, args: unknown): Record<string, string> | string {
  const input = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(spec.params)) {
    const value = input[name];
    if (value === undefined || value === null || value === '') {
      if (p.optional) continue;
      return `Missing required argument: ${name}`;
    }
    if (typeof value !== 'string') return `Argument ${name} must be a string`;
    if (p.type === 'enum' && !p.values.includes(value)) return `Argument ${name} must be one of: ${p.values.join(', ')}`;
    out[name] = value;
  }
  return out;
}

async function checkScaffold(abs: string): Promise<ScaffoldCheck> {
  try {
    return (await readFile(abs, 'utf8')).includes('SPOTME:') ? 'ok' : 'missingMarker';
  } catch {
    return 'missingFile';
  }
}

export function openSpotMe(root: ProjectRoot, vocab: Vocab, opts: SpotMeOptions = {}): SpotMe {
  const env = opts.env ?? process.env;
  const store = opts.store ?? openStore(root, { dir: stateDir(env) });
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const runCommand = async (name: CommandName, args: string): Promise<CommandReply> => {
    const out = await store.transact((s) => command(s, name, args));
    return { kind: out.kind, text: renderCommand(out, root, vocab) };
  };

  return {
    root,
    store,
    async onWrite(raws) {
      const write = toCodeWrite(root, raws);
      if (!write) return { allow: true };
      try {
        if ((await store.read()).mode.kind !== 'idle') return { allow: true };
        const out = await store.transact((s) => step(s, { type: 'write', write }));
        return out.type === 'allow' ? { allow: true } : { allow: false, reason: renderWriteDenial(out, vocab) };
      } catch (e) {
        log(`spotme: allowing write after error: ${e instanceof Error ? e.message : String(e)}`);
        return { allow: true };
      }
    },
    command: runCommand,
    async peekCommand(name, args) {
      return command(await store.read(), name, args)[1].kind;
    },
    async callTool(name, args) {
      if (!(name in TOOLS)) return { ok: false, text: `Unknown SpotMe tool: ${name}` };
      const parsed = parseArgs(TOOLS[name as ToolName], args);
      if (typeof parsed === 'string') return { ok: false, text: parsed };
      switch (name as ToolName) {
        case 'spotme_exercise': {
          const raw = parsed.filePath!;
          const difficulty = parsed.difficulty!;
          if (!isDifficulty(difficulty)) return { ok: false, text: `Unknown difficulty: ${difficulty}` };
          const exercise = { unit: parsed.unit!, path: displayPath(root, raw), difficulty };
          const check = await checkScaffold(resolve(root, raw));
          const out = await store.transact((s) => step(s, { type: 'register', exercise, check }));
          return out.type === 'ready'
            ? { ok: true, text: renderReady(out.exercise, vocab) }
            : { ok: false, text: renderRegisterRefusal(out, vocab) };
        }
        case 'spotme_status':
          return { ok: true, text: renderStatus(await store.read(), root) };
        case 'spotme_end':
          await store.transact((s) => step(s, { type: 'end' }));
          return { ok: true, text: ENDED };
        case 'spotme_command': {
          const cmd = parsed.name!;
          if (!isCommandName(cmd)) return { ok: false, text: `Unknown SpotMe command: ${cmd}` };
          const reply = await runCommand(cmd, parsed.args ?? '');
          return { ok: true, text: relay(reply.kind, reply.text) };
        }
      }
    },
  };
}
