import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { Io, Flags } from './cli.ts';
import type { ProjectRoot } from './engine.ts';
import type { Asset, InstallCtx, Json, JsonObject, Scope } from './harness.ts';
import { HARNESSES, HARNESS_IDS, isHarnessId } from './harnesses.ts';
import type { HarnessId } from './harnesses.ts';
import { canonicalRoot, openStore, rootDirFrom, stateDir } from './store.ts';

export type Op = 'install' | 'uninstall';
export type Action = 'create' | 'update' | 'remove' | 'unchanged' | 'absent';

export interface FileChange {
  readonly path: string;
  readonly action: Action;
  readonly content: string | null;
}

export interface Plan {
  readonly changes: readonly FileChange[];
  readonly notes: readonly string[];
  readonly errors: readonly string[];
}

export const TOML_BEGIN = '# >>> spotme >>>';
export const TOML_END = '# <<< spotme <<<';
const TOML_BLOCK = /\n*# >>> spotme >>>\n[\s\S]*?# <<< spotme <<<\n?/g;

const isObject = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null && !Array.isArray(x);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function tomlNext(current: string | null, body: string, op: Op, path: string, errors: string[]): string | null {
  const rest = (current ?? '').replace(TOML_BLOCK, '\n').replace(/^\n+/, '');
  if (op === 'uninstall') return rest.trim() ? `${rest.trimEnd()}\n` : null;
  const headers = body.split('\n').filter((l) => /^\s*\[.+\]\s*$/.test(l));
  const clash = headers.find((h) => rest.split('\n').some((l) => l.trim() === h.trim()));
  if (clash) errors.push(`${path} already defines ${clash.trim()} outside the spotme block; remove it and rerun.`);
  const block = `${TOML_BEGIN}\n${body.endsWith('\n') ? body : `${body}\n`}${TOML_END}\n`;
  return rest.trim() ? `${rest.trimEnd()}\n\n${block}` : block;
}

export async function plan(assets: readonly Asset[], op: Op): Promise<Plan> {
  const original = new Map<string, string | null>();
  const view = new Map<string, string | null>();
  const notes: string[] = [];
  const errors: string[] = [];
  const current = async (path: string) => {
    if (!view.has(path)) {
      const text = await readText(path);
      original.set(path, text);
      view.set(path, text);
    }
    return view.get(path) ?? null;
  };

  for (const asset of assets) {
    if (asset.kind === 'note') {
      if (op === 'install') notes.push(asset.text);
      continue;
    }
    const text = await current(asset.path);
    if (asset.kind === 'file') {
      view.set(asset.path, op === 'install' ? asset.content : null);
    } else if (asset.kind === 'tomlBlock') {
      view.set(asset.path, tomlNext(text, asset.body, op, asset.path, errors));
    } else {
      let doc: unknown = {};
      if (text !== null && text.trim()) {
        try {
          doc = JSON.parse(text);
        } catch {
          errors.push(`${asset.path} is not valid JSON (comments are not supported); fix it and rerun.`);
          continue;
        }
      }
      if (!isObject(doc)) {
        errors.push(`${asset.path} does not hold a JSON object; fix it and rerun.`);
        continue;
      }
      const next = asset.edit(doc, op);
      if (isDeepStrictEqual(doc, next)) continue;
      view.set(asset.path, op === 'uninstall' && Object.keys(next).length === 0 ? null : `${JSON.stringify(next as Json, null, 2)}\n`);
    }
  }

  const changes: FileChange[] = [];
  for (const [path, content] of view) {
    const before = original.get(path) ?? null;
    const action: Action =
      before === content ? (content === null ? 'absent' : 'unchanged') : before === null ? 'create' : content === null ? 'remove' : 'update';
    changes.push({ path, action, content });
  }
  return { changes, notes, errors };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.spotme-${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function pruneOwnedDirs(path: string): Promise<void> {
  for (let dir = dirname(path); /spotme/i.test(basename(dir)) || /spotme/i.test(dirname(dir)); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    if (!/spotme/i.test(basename(dir))) return;
  }
}

export async function apply(p: Plan): Promise<void> {
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  for (const c of p.changes) {
    if (c.action === 'create' || c.action === 'update') await writeAtomic(c.path, c.content!);
    if (c.action === 'remove') {
      await unlink(c.path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      await pruneOwnedDirs(c.path);
    }
  }
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'spotme') : join(env.HOME || homedir(), '.local', 'share', 'spotme');
}

export function runtimeSources(): { cli: string | null; opencode: string | null } {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = basename(here) === 'src' ? join(here, '..', 'dist') : here;
  const pick = (name: string) => (existsSync(join(dir, name)) ? join(dir, name) : null);
  return { cli: pick('cli.mjs'), opencode: pick('opencode.js') };
}

export interface CtxOptions {
  readonly scope: Scope;
  readonly project: ProjectRoot;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly bin?: string;
  readonly stateDir?: string;
}

export function installCtx(harness: HarnessId, o: CtxOptions): InstallCtx {
  const data = dataDir(o.env);
  const bin = o.bin ? o.bin.trim().split(/\s+/) : [process.execPath, join(data, 'runtime', 'cli.mjs')];
  const baked = [...(o.scope === 'project' ? ['--root', o.project] : []), ...(o.stateDir ? ['--state-dir', o.stateDir] : [])];
  return {
    harness,
    scope: o.scope,
    project: o.project,
    home: o.env.HOME || homedir(),
    dataDir: data,
    bin,
    baked,
    stateDir: o.stateDir ?? null,
    version: o.version,
  };
}

async function runtimeChanges(env: NodeJS.ProcessEnv, needCli: boolean): Promise<Plan> {
  const src = runtimeSources();
  const target = join(dataDir(env), 'runtime');
  const errors: string[] = [];
  const changes: FileChange[] = [];
  if (!src.cli && needCli) errors.push('dist/cli.mjs is missing; run `npm run build` first, or pass --bin.');
  for (const [name, from] of [['cli.mjs', src.cli], ['opencode.js', src.opencode]] as const) {
    if (!from) continue;
    const content = await readFile(from, 'utf8');
    const path = join(target, name);
    const before = await readText(path);
    changes.push({ path, action: before === null ? 'create' : before === content ? 'unchanged' : 'update', content });
  }
  return { changes, notes: [], errors };
}

export function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (env.PATH ?? '').split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, binary + x))));
}

export type Presence = 'installed' | 'outdated' | 'absent' | 'external';

export async function presence(ctx: InstallCtx): Promise<Presence> {
  const assets = HARNESSES[ctx.harness as HarnessId].assets(ctx);
  if (assets.every((a) => a.kind === 'note')) return 'external';
  const install = await plan(assets, 'install');
  if (install.errors.length === 0 && install.changes.every((c) => c.action === 'unchanged')) return 'installed';
  const uninstall = await plan(assets, 'uninstall');
  return uninstall.changes.every((c) => c.action === 'absent' || c.action === 'unchanged') ? 'absent' : 'outdated';
}

const VERB_LABEL: Record<Action, string> = { create: 'create', update: 'update', remove: 'remove', unchanged: 'unchanged', absent: 'absent' };

function printPlan(io: Io, p: Plan, dryRun: boolean): void {
  for (const c of p.changes) {
    if (c.action === 'absent') continue;
    const verb = dryRun && c.action !== 'unchanged' ? `would ${VERB_LABEL[c.action]}` : VERB_LABEL[c.action];
    io.out(`  ${verb.padEnd(16)} ${c.path}\n`);
  }
  for (const n of p.notes) io.out(`  note: ${n.replace(/\n/g, '\n        ')}\n`);
  for (const e of p.errors) io.err(`  error: ${e}\n`);
}

function resolveScope(id: HarnessId, requested: Scope | undefined): Scope | string {
  const scopes = HARNESSES[id].scopes;
  if (!requested) return scopes[0]!;
  return scopes.includes(requested) ? requested : `${id} does not support --${requested}; use --${scopes[0]}`;
}

export async function runInstallCli(
  verb: 'install' | 'uninstall' | 'doctor',
  rest: readonly string[],
  flags: Flags,
  env: NodeJS.ProcessEnv,
  io: Io,
  version: string,
): Promise<number> {
  const project = canonicalRoot(rootDirFrom(flags.root, env, io.cwd));
  const stateDirFlag = flags.stateDir ? resolve(io.cwd, flags.stateDir) : undefined;
  const ctxFor = (id: HarnessId, scope: Scope) => installCtx(id, { scope, project, env, version, bin: flags.bin, stateDir: stateDirFlag });

  if (verb === 'doctor') return doctor(project, ctxFor, env, io);

  const target = rest[0];
  if (target !== 'all' && !isHarnessId(target)) {
    io.err(`usage: spotme ${verb} <${HARNESS_IDS.join('|')}|all> [--project|--user]\n`);
    return 2;
  }
  const ids = target === 'all' ? HARNESS_IDS.filter((id) => onPath(HARNESSES[id].binary, env)) : [target];
  if (target === 'all') io.out(`Detected on PATH: ${ids.length > 0 ? ids.join(', ') : 'none'}\n`);

  const op: Op = verb;
  let failed = false;
  if (op === 'install') {
    const runtime = await runtimeChanges(env, !flags.bin);
    io.out(`runtime:\n`);
    printPlan(io, runtime, flags.dryRun);
    if (runtime.errors.length > 0) return 1;
    if (!flags.dryRun) await apply(runtime);
  }
  for (const id of ids) {
    const scope = resolveScope(id, flags.scope);
    if (scope !== 'project' && scope !== 'user') {
      io.err(`${scope}\n`);
      failed = true;
      continue;
    }
    const ctx = ctxFor(id, scope);
    const p = await plan(HARNESSES[id].assets(ctx), op);
    io.out(`${id} (${scope}):\n`);
    printPlan(io, p, flags.dryRun);
    if (p.errors.length > 0) {
      failed = true;
      continue;
    }
    if (!flags.dryRun) await apply(p);
    const other: Scope = scope === 'project' ? 'user' : 'project';
    if (op === 'install' && HARNESSES[id].scopes.includes(other) && (await presence(ctxFor(id, other))) !== 'absent') {
      io.err(`  warning: ${id} also has SpotMe at ${other} scope; every write would be counted twice. Run \`spotme uninstall ${id} --${other}\`.\n`);
    }
  }
  return failed ? 1 : 0;
}

async function doctor(
  project: ProjectRoot,
  ctxFor: (id: HarnessId, scope: Scope) => InstallCtx,
  env: NodeJS.ProcessEnv,
  io: Io,
): Promise<number> {
  let warnings = 0;
  const warn = (text: string) => {
    warnings++;
    io.out(`  warning: ${text}\n`);
  };
  io.out(`Project: ${project}\n`);
  const runtime = join(dataDir(env), 'runtime', 'cli.mjs');
  io.out(`Runtime: ${existsSync(runtime) ? runtime : `${runtime} (missing; run spotme install)`}\n`);
  const store = openStore(project, { dir: stateDir(env) });
  const state = await store.read();
  io.out(`State:   ${store.file} (${state.mode.kind})\n`);
  for (const id of HARNESS_IDS) {
    const h = HARNESSES[id];
    const found = onPath(h.binary, env);
    const scopes = await Promise.all(h.scopes.map(async (s) => [s, await presence(ctxFor(id, s))] as const));
    const shown = scopes.map(([s, p]) => `${s} ${p === 'external' ? `see \`spotme install ${id}\`` : p}`).join(', ');
    io.out(`${id.padEnd(9)} ${found ? 'on PATH' : 'not on PATH'}; ${shown}\n`);
    const present = scopes.filter(([, p]) => p === 'installed' || p === 'outdated');
    if (present.length > 1) warn(`${id} is installed at both scopes; every write is counted twice.`);
    if (scopes.some(([, p]) => p === 'outdated')) warn(`${id} config differs from this version or these flags; rerun \`spotme install ${id}\`.`);
    if (present.length > 0) {
      const bin = ctxFor(id, present[0]![0]).bin[0]!;
      if (bin.includes('/') && !existsSync(bin)) warn(`${id} hooks launch ${bin}, which does not exist.`);
    }
  }
  return warnings > 0 ? 1 : 0;
}
