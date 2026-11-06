import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { INITIAL, isDifficulty, toEvery } from './engine.ts';
import type { CodeWrite, DisplayPath, Exercise, Mode, ProjectRoot, Settings, State } from './engine.ts';

/** realpath, then the nearest ancestor holding `.git` (a file in worktrees), else the directory itself. */
export function canonicalRoot(dir: string): ProjectRoot {
  const real = realpathSync(dir);
  for (let d = real; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d as ProjectRoot;
    if (dirname(d) === d) return real as ProjectRoot;
  }
}

export function stateDir(env: NodeJS.ProcessEnv): string {
  if (env.SPOTME_STATE_DIR) return env.SPOTME_STATE_DIR;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'spotme');
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'spotme');
  return join(env.HOME || homedir(), '.local', 'state', 'spotme');
}

export function stateKey(root: ProjectRoot): string {
  return createHash('sha256').update(root).digest('hex');
}

export class LockTimeout extends Error {}

export interface Store {
  readonly file: string;
  /** Lock-free snapshot; a missing or unreadable document reads as INITIAL. */
  read(): Promise<State>;
  /** Serialized read-modify-write. Writes only when `f` returns a different State object. */
  transact<T>(f: (s: State) => readonly [State, T]): Promise<T>;
}

export interface StoreOptions {
  readonly dir: string;
  readonly lockTimeoutMs?: number;
  readonly staleMs?: number;
}

interface Owner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === 'EPERM';
  }
}

async function readOwner(path: string): Promise<Owner | null | 'gone'> {
  try {
    const o = JSON.parse(await readFile(path, 'utf8')) as Partial<Owner>;
    return typeof o.pid === 'number' && typeof o.token === 'string' && typeof o.at === 'number' && typeof o.host === 'string'
      ? (o as Owner)
      : null;
  } catch (e) {
    return code(e) === 'ENOENT' ? 'gone' : null;
  }
}

export function openStore(root: ProjectRoot, opts: StoreOptions): Store {
  const key = stateKey(root);
  const file = join(opts.dir, `${key}.json`);
  const lock = join(opts.dir, `${key}.lock`);
  const lockTimeoutMs = opts.lockTimeoutMs ?? 2000;
  const staleMs = opts.staleMs ?? 10_000;

  const isStale = async (owner: Owner | null): Promise<boolean | 'gone'> => {
    if (owner) return (owner.host === hostname() && !pidAlive(owner.pid)) || Date.now() - owner.at > staleMs;
    try {
      return Date.now() - (await stat(lock)).mtimeMs > staleMs;
    } catch (e) {
      if (code(e) === 'ENOENT') return 'gone';
      throw e;
    }
  };

  // Rename is atomic, so only one breaker moves a given lock away. If the lock was replaced
  // between our judgement and the rename, we moved a live lock and put it back with link(),
  // which fails rather than clobbering a newer one.
  const breakLock = async (judged: Owner | null, token: string) => {
    const tomb = `${lock}.stale.${token}`;
    try {
      await rename(lock, tomb);
    } catch (e) {
      if (code(e) === 'ENOENT') return;
      throw e;
    }
    const moved = await readOwner(tomb);
    const same = moved === 'gone' || (moved === null ? judged === null : moved.token === judged?.token);
    if (!same) await link(tomb, lock).catch(() => undefined);
    await unlink(tomb).catch(() => undefined);
  };

  const acquire = async (token: string) => {
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      try {
        const fh = await open(lock, 'wx');
        try {
          const owner: Owner = { pid: process.pid, host: hostname(), token, at: Date.now() };
          await fh.writeFile(JSON.stringify(owner));
        } finally {
          await fh.close();
        }
        return;
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
      }
      const current = await readOwner(lock);
      if (current === 'gone') continue;
      const stale = await isStale(current);
      if (stale === 'gone') continue;
      if (stale) {
        await breakLock(current, token);
        continue;
      }
      if (Date.now() > deadline) throw new LockTimeout(`SpotMe state lock busy: ${lock}`);
      await sleep(5 + Math.random() * 15);
    }
  };

  const release = async (token: string) => {
    const current = await readOwner(lock);
    if (current !== 'gone' && current?.token === token) await unlink(lock).catch(() => undefined);
  };

  const load = async (quarantine: boolean): Promise<State> => {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if (code(e) === 'ENOENT') return INITIAL;
      throw e;
    }
    let parsed: State | null = null;
    try {
      parsed = parseDoc(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed) return parsed;
    if (quarantine) await rename(file, join(opts.dir, `${key}.corrupt-${Date.now()}.json`)).catch(() => undefined);
    return INITIAL;
  };

  const save = async (state: State) => {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(`${JSON.stringify({ v: 1, root, state }, null, 2)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  };

  return {
    file,
    read: () => load(false),
    async transact(f) {
      await mkdir(opts.dir, { recursive: true });
      const token = randomBytes(8).toString('hex');
      await acquire(token);
      try {
        const prev = await load(true);
        const [next, out] = f(prev);
        if (next !== prev) await save(next);
        return out;
      } finally {
        await release(token);
      }
    },
  };
}

type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: Json): x is string => typeof x === 'string' && x.length > 0;

function parseCodeWrite(x: Json): CodeWrite | null {
  if (!isObj(x) || (x.kind !== 'create' && x.kind !== 'edit') || !str(x.path)) return null;
  return { kind: x.kind, path: x.path as DisplayPath };
}

function parseExercise(x: Json): Exercise | null {
  if (!isObj(x) || !str(x.unit) || !str(x.path) || !isDifficulty(x.difficulty)) return null;
  return { unit: x.unit, path: x.path as DisplayPath, difficulty: x.difficulty };
}

function parseMode(x: Json, settings: Settings): Mode | null {
  if (!isObj(x)) return null;
  switch (x.kind) {
    case 'off':
      return { kind: 'off' };
    case 'idle': {
      const n = typeof x.count === 'number' && Number.isInteger(x.count) ? x.count : 0;
      return { kind: 'idle', count: Math.min(Math.max(n, 0), settings.every - 1) };
    }
    case 'awaitingScaffold': {
      const trigger = parseCodeWrite(x.trigger);
      return trigger && { kind: 'awaitingScaffold', trigger };
    }
    case 'active': {
      const exercise = parseExercise(x.exercise);
      return exercise && { kind: 'active', exercise };
    }
    default:
      return null;
  }
}

/** Boundary parse of the stored document `{ v, root, state }`. */
export function parseDoc(doc: Json): State | null {
  if (!isObj(doc) || doc.v !== 1 || !isObj(doc.state)) return null;
  const s = doc.state;
  if (s.v !== 1 || !isObj(s.settings)) return null;
  const every = typeof s.settings.every === 'number' ? toEvery(s.settings.every) : null;
  if (!every || !isDifficulty(s.settings.difficulty)) return null;
  const settings: Settings = { difficulty: s.settings.difficulty, every };
  const mode = parseMode(s.mode, settings);
  return mode && { v: 1, settings, mode };
}
