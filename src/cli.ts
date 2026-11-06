#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { COMMAND_NAMES, isCommandName } from './engine.ts';
import type { Scope } from './harness.ts';
import { GENERIC_VOCAB, HARNESSES, HARNESS_IDS, isHarnessId } from './harnesses.ts';
import type { HarnessId } from './harnesses.ts';
import { runHook } from './hook.ts';
import { relay } from './messages.ts';
import { openSpotMe } from './session.ts';
import { canonicalRoot, rootDirFrom } from './store.ts';

export const VERSION: string = pkg.version;

export interface Io {
  readonly stdin: AsyncIterable<string | Buffer>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
}

export interface Flags {
  root?: string;
  stateDir?: string;
  harness?: HarnessId;
  bin?: string;
  unit?: string;
  file?: string;
  difficulty?: string;
  scope?: Scope;
  forModel: boolean;
  dryRun: boolean;
}

const VALUE_FLAGS = { '--root': 'root', '--state-dir': 'stateDir', '--bin': 'bin', '--unit': 'unit', '--file': 'file', '--difficulty': 'difficulty' } as const;

function parseArgv(argv: readonly string[]): { positional: string[]; flags: Flags } | string {
  const flags: Flags = { forModel: false, dryRun: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a in VALUE_FLAGS) {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      flags[VALUE_FLAGS[a as keyof typeof VALUE_FLAGS]] = value;
    } else if (a === '--harness') {
      const value = argv[++i];
      if (!isHarnessId(value)) return `--harness must be one of: ${HARNESS_IDS.join(', ')}`;
      flags.harness = value;
    } else if (a === '--for-model') flags.forModel = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--user') flags.scope = 'user';
    else if (a === '--project') flags.scope = 'project';
    else positional.push(a);
  }
  return { positional, flags };
}

async function readAll(stream: AsyncIterable<string | Buffer>): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return text;
}

const USAGE = `spotme ${VERSION}: gym mode for coding agents

  spotme install <harness|all> [--project|--user] [--root DIR] [--state-dir DIR] [--bin CMD] [--dry-run]
  spotme uninstall <harness|all> [--project|--user] [--root DIR]
  spotme doctor [--root DIR]
  spotme <${COMMAND_NAMES.join('|')}> [args...] [--harness H] [--root DIR] [--for-model]
  spotme exercise --unit NAME --file PATH --difficulty lite|medium|hard
  spotme end
  spotme hook <harness> <write|prompt> [--root DIR] [--state-dir DIR]   (stdin: hook payload)
  spotme mcp [--harness H] [--root DIR] [--state-dir DIR]

Harnesses: ${HARNESS_IDS.join(', ')}`;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const parsed = parseArgv(argv);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n`);
    return 2;
  }
  const { positional, flags } = parsed;
  if (flags.stateDir) env.SPOTME_STATE_DIR = resolve(io.cwd, flags.stateDir);
  const [verb, ...rest] = positional;
  const vocab = flags.harness ? HARNESSES[flags.harness].vocab : GENERIC_VOCAB;
  const session = () => openSpotMe(canonicalRoot(rootDirFrom(flags.root, env, io.cwd)), vocab, { env });

  switch (verb) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(`${USAGE}\n`);
      return verb === undefined ? 2 : 0;
    case '--version':
    case 'version':
      io.out(`${VERSION}\n`);
      return 0;
    case 'hook': {
      const [id, event] = rest;
      if (!isHarnessId(id) || (event !== 'write' && event !== 'prompt')) {
        io.err('usage: spotme hook <harness> <write|prompt>\n');
        return 2;
      }
      const reply = await runHook(id, event, await readAll(io.stdin), env, flags.root ? resolve(io.cwd, flags.root) : undefined);
      io.out(reply.stdout);
      return reply.exitCode;
    }
    case 'mcp': {
      const { serveMcp } = await import('./mcp.ts');
      await serveMcp({ harness: flags.harness, rootFlag: flags.root, env, cwd: io.cwd, input: io.stdin, write: io.out, version: VERSION });
      return 0;
    }
    case 'install':
    case 'uninstall':
    case 'doctor': {
      const { runInstallCli } = await import('./install.ts');
      return runInstallCli(verb, rest, flags, env, io, VERSION);
    }
    case 'exercise': {
      if (!flags.unit || !flags.file || !flags.difficulty) {
        io.err('usage: spotme exercise --unit NAME --file PATH --difficulty lite|medium|hard\n');
        return 2;
      }
      const r = await session().callTool('spotme_exercise', {
        unit: flags.unit,
        filePath: resolve(io.cwd, flags.file),
        difficulty: flags.difficulty,
      });
      io.out(`${r.text}\n`);
      return r.ok ? 0 : 1;
    }
    case 'end': {
      const r = await session().callTool('spotme_end', {});
      io.out(`${r.text}\n`);
      return 0;
    }
    default: {
      if (!isCommandName(verb)) {
        io.err(`unknown command: ${verb}\n\n${USAGE}\n`);
        return 2;
      }
      const r = await session().command(verb, rest.join(' '));
      io.out(`${flags.forModel ? relay(r.kind, r.text) : r.text}\n`);
      return 0;
    }
  }
}

function isEntrypoint(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.stdin.setEncoding('utf8');
  const io: Io = {
    stdin: process.stdin,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    cwd: process.cwd(),
  };
  main(process.argv.slice(2), process.env, io).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`spotme: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
