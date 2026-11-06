import { join } from 'node:path';
import type { CommandName, ProjectRoot, RawWrite, WriteKind } from './engine.ts';
import { skillMarkdown, SKILL_DESCRIPTION } from './messages.ts';
import type { Vocab } from './messages.ts';

export type Extractor = (toolInput: unknown) => readonly RawWrite[];
/** Tool name as the harness reports it, mapped to the paths that call writes. */
export type WriteTable = Readonly<Record<string, Extractor>>;

export type HookEvent = 'write' | 'prompt';

export interface HookPayload {
  readonly dir: string | undefined;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly prompt?: string;
}

export interface HookReply {
  readonly stdout: string;
  readonly exitCode: 0;
}

export interface HookProtocol {
  /** Native event names. `prompt: null` means the harness has no usable prompt hook. */
  readonly events: { readonly write: string; readonly prompt: string | null };
  parse(event: HookEvent, stdin: unknown, env: NodeJS.ProcessEnv): HookPayload | null;
  deny(reason: string): HookReply;
  /** No opinion. Must not auto-approve where the harness has its own permission prompt. */
  pass(event: HookEvent): HookReply;
  /** End the prompt without a model turn; `text` must reach the user. */
  stop(text: string): HookReply;
}

export type Scope = 'user' | 'project';

export interface InstallCtx {
  readonly harness: string;
  readonly scope: Scope;
  readonly project: ProjectRoot;
  readonly home: string;
  readonly dataDir: string;
  /** argv that launches spotme, e.g. [node, ~/.local/share/spotme/runtime/cli.mjs]. */
  readonly bin: readonly string[];
  /** Arguments appended to every hook and MCP invocation: --root for project scope, --state-dir when given. */
  readonly baked: readonly string[];
  readonly stateDir: string | null;
  readonly version: string;
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/**
 * `file` is wholly owned. `json` and `tomlBlock` edit a file the user also owns: they remove every
 * spotme-owned entry and, on install, add the current ones, so a rerun converges.
 */
export type Asset =
  | { readonly kind: 'file'; readonly path: string; readonly content: string }
  | { readonly kind: 'json'; readonly path: string; readonly edit: (doc: JsonObject, op: 'install' | 'uninstall') => JsonObject }
  | { readonly kind: 'tomlBlock'; readonly path: string; readonly body: string }
  | { readonly kind: 'note'; readonly text: string };

export interface Harness {
  readonly vocab: Vocab;
  readonly writes: WriteTable;
  /** null for in-process harnesses (OpenCode, Pi). */
  readonly hooks: HookProtocol | null;
  readonly scopes: readonly Scope[];
  /** Executable looked up on PATH by `install all`. */
  readonly binary: string;
  assets(ctx: InstallCtx): readonly Asset[];
}

export const field = (input: unknown, key: string): unknown =>
  typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;

export function pathField(key: string, kind: WriteKind): Extractor {
  return (input) => {
    const v = field(input, key);
    return typeof v === 'string' && v ? [{ kind, path: v }] : [];
  };
}

export function patchField(key: string): Extractor {
  return (input) => {
    const v = field(input, key);
    return typeof v === 'string' ? parsePatch(v) : [];
  };
}

/** Codex-style patch headers. Delete counts as nothing; Move retargets the preceding Update. */
export function parsePatch(text: string): readonly RawWrite[] {
  const out: RawWrite[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\*\* (Add File|Update File|Move to|Delete File): (.+)$/.exec(line.trim());
    if (!m) continue;
    const [, header, path] = m as unknown as [string, string, string];
    if (header === 'Add File') out.push({ kind: 'create', path: path.trim() });
    if (header === 'Update File') out.push({ kind: 'edit', path: path.trim() });
    if (header === 'Move to' && out.at(-1)?.kind === 'edit') out[out.length - 1] = { kind: 'edit', path: path.trim() };
  }
  return out;
}

export function extractWrites(table: WriteTable, toolName: string, input: unknown): readonly RawWrite[] {
  const lower = toolName.toLowerCase();
  const key = Object.keys(table).find((k) => k.toLowerCase() === lower);
  return key ? table[key]!(input) : [];
}

export function writeMatcher(table: WriteTable): string {
  return `^(${Object.keys(table).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

/** Recognizes `/spotme:on hard`, `/spotme-on`, `spotme:on`, and the sentinel heading generated command files. */
export function parsePromptCommand(
  prompt: string,
  isName: (s: string) => s is CommandName,
): { readonly name: CommandName; readonly args: string } | null {
  const first = prompt.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const m =
    /^<!-- spotme:command (\w+)\s*(.*?)\s*-->$/.exec(first) ?? /^\/?spotme[:-](\w+)(?:\s+(.*))?$/i.exec(first);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return isName(name) ? { name, args: (m[2] ?? '').trim() } : null;
}

const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

/**
 * Droid, Claude Code and Codex share this PreToolUse / UserPromptSubmit JSON.
 * Empty stdout is "no opinion"; an explicit allow would skip the harness's own permission prompt.
 */
export function parseCommonPayload(stdin: unknown, env: NodeJS.ProcessEnv, dirEnv: string | null): HookPayload {
  return {
    dir: (dirEnv ? str(env[dirEnv]) : undefined) ?? str(field(stdin, 'cwd')),
    toolName: str(field(stdin, 'tool_name')),
    toolInput: field(stdin, 'tool_input'),
    prompt: str(field(stdin, 'prompt')),
  };
}

export function claudeFamily(opts: { readonly prompt: 'UserPromptSubmit' | null; readonly dirEnv: string | null }): HookProtocol {
  return {
    events: { write: 'PreToolUse', prompt: opts.prompt },
    parse: (_event, stdin, env) => parseCommonPayload(stdin, env, opts.dirEnv),
    deny: (reason) => ({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }),
      exitCode: 0,
    }),
    pass: () => ({ stdout: '', exitCode: 0 }),
    stop: (text) => ({ stdout: JSON.stringify({ decision: 'block', reason: text }), exitCode: 0 }),
  };
}

const SH_SAFE = /^[A-Za-z0-9_\-+=/.,:@%]+$/;
export function shellQuote(arg: string): string {
  return SH_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function hookArgv(ctx: InstallCtx, event: HookEvent): readonly string[] {
  return [...ctx.bin, 'hook', ctx.harness, event, ...ctx.baked];
}

export function hookCommand(ctx: InstallCtx, event: HookEvent): string {
  return hookArgv(ctx, event).map(shellQuote).join(' ');
}

export function mcpArgv(ctx: InstallCtx): readonly string[] {
  return [...ctx.bin, 'mcp', '--harness', ctx.harness, ...ctx.baked];
}

/** Matches any hook command install ever wrote, whatever launcher prefix it used. */
export function isOwnedCommand(command: unknown): boolean {
  return typeof command === 'string' && /spotme/i.test(command) && /\shook\s+[a-z]+\s+(?:write|prompt)(?:\s|$)/.test(command);
}

export interface HookSpec {
  readonly event: string;
  readonly matcher?: string;
  readonly command: string;
}

const isObject = (x: Json | undefined): x is JsonObject => typeof x === 'object' && x !== null && !Array.isArray(x);

function withoutOwned(entries: Json | undefined, cursor: boolean): Json[] {
  if (!Array.isArray(entries)) return [];
  const out: Json[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
      out.push(entry);
      continue;
    }
    if (cursor) {
      if (!isOwnedCommand(entry.command)) out.push(entry);
      continue;
    }
    if (!Array.isArray(entry.hooks)) {
      out.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter((h) => !(isObject(h) && isOwnedCommand(h.command)));
    if (hooks.length > 0) out.push({ ...entry, hooks });
  }
  return out;
}

/**
 * 'bare'      Droid: { "<Event>": [{ matcher?, hooks: [{ type, command }] }] }
 * 'wrapped'   Claude, Codex, Gemini: { "hooks": { "<Event>": [...] } }
 * 'cursor-v1' { "version": 1, "hooks": { "<event>": [{ command, matcher? }] } }
 */
export function hooksJson(
  path: string,
  shape: 'bare' | 'wrapped' | 'cursor-v1',
  specs: readonly HookSpec[],
  extra: { readonly timeoutMs?: number } = {},
): Asset {
  return {
    kind: 'json',
    path,
    edit(doc, op) {
      const next: JsonObject = structuredClone(doc);
      const container: JsonObject = shape === 'bare' ? next : isObject(next.hooks) ? next.hooks : {};
      const cursor = shape === 'cursor-v1';
      for (const event of Object.keys(container)) {
        if (shape === 'bare' && !Array.isArray(container[event])) continue;
        const kept = withoutOwned(container[event], cursor);
        if (kept.length > 0) container[event] = kept;
        else delete container[event];
      }
      if (op === 'install') {
        for (const spec of specs) {
          const entry: JsonObject = cursor
            ? { command: spec.command, ...(spec.matcher ? { matcher: spec.matcher } : {}) }
            : {
                ...(spec.matcher ? { matcher: spec.matcher } : {}),
                hooks: [{ type: 'command', command: spec.command, ...(extra.timeoutMs ? { timeout: extra.timeoutMs } : {}) }],
              };
          const list = Array.isArray(container[spec.event]) ? (container[spec.event] as Json[]) : [];
          container[spec.event] = [...list, entry];
        }
      }
      if (shape !== 'bare') {
        if (Object.keys(container).length > 0) next.hooks = container;
        else delete next.hooks;
      }
      if (cursor) {
        if (next.hooks) next.version ??= 1;
        else if (Object.keys(next).length === 1 && next.version === 1) delete next.version;
      }
      return next;
    },
  };
}

/** `{ <key>: { spotme: entry } }`, dropping the container when it empties. */
export function namedEntryJson(path: string, key: string, name: string, entry: Json): Asset {
  return {
    kind: 'json',
    path,
    edit(doc, op) {
      const next: JsonObject = structuredClone(doc);
      const servers: JsonObject = isObject(next[key]) ? next[key] : {};
      if (op === 'install') servers[name] = entry;
      else delete servers[name];
      if (Object.keys(servers).length > 0) next[key] = servers;
      else delete next[key];
      return next;
    },
  };
}

export function mcpServersJson(path: string, ctx: InstallCtx, extra: JsonObject = {}): Asset {
  const [command, ...args] = mcpArgv(ctx);
  return namedEntryJson(path, 'mcpServers', 'spotme', { ...extra, command: command!, args });
}

export function file(path: string, content: string | Json): Asset {
  return { kind: 'file', path, content: typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n` };
}

export function skillFile(path: string, vocab: Vocab): Asset {
  return file(path, `---\nname: spotme\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${skillMarkdown(vocab)}`);
}

export function note(text: string): Asset {
  return { kind: 'note', text };
}

export function scopeBase(ctx: InstallCtx, dot: string): string {
  return join(ctx.scope === 'project' ? ctx.project : ctx.home, dot);
}
