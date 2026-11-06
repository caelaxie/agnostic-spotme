import { isAbsolute, relative, resolve, sep } from 'node:path';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export const DIFFICULTIES = ['lite', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type Every = Brand<number, 'Every'>;
export type ProjectRoot = Brand<string, 'ProjectRoot'>;
/** Root-relative POSIX path when inside the root, absolute otherwise. */
export type DisplayPath = Brand<string, 'DisplayPath'>;

export function toEvery(n: number): Every | null {
  return Number.isInteger(n) && n >= 1 ? (n as Every) : null;
}

export function isDifficulty(s: unknown): s is Difficulty {
  return typeof s === 'string' && (DIFFICULTIES as readonly string[]).includes(s);
}

export function displayPath(root: ProjectRoot, raw: string): DisplayPath {
  const abs = resolve(root, raw);
  const rel = relative(root, abs);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  return (inside ? rel.split(sep).join('/') : abs) as DisplayPath;
}

export interface Settings {
  readonly difficulty: Difficulty;
  readonly every: Every;
}
export const DEFAULT_SETTINGS: Settings = { difficulty: 'medium', every: 2 as Every };

export type WriteKind = 'create' | 'edit';

export interface RawWrite {
  readonly kind: WriteKind;
  readonly path: string;
}

export interface CodeWrite {
  readonly kind: WriteKind;
  readonly path: DisplayPath;
}

export interface Exercise {
  readonly unit: string;
  readonly path: DisplayPath;
  readonly difficulty: Difficulty;
}

/** Invariant kept by `step` and enforced by store.parseDoc: idle.count < settings.every. */
export type Mode =
  | { readonly kind: 'off' }
  | { readonly kind: 'idle'; readonly count: number }
  | { readonly kind: 'awaitingScaffold'; readonly trigger: CodeWrite }
  | { readonly kind: 'active'; readonly exercise: Exercise };

export interface State {
  readonly v: 1;
  readonly settings: Settings;
  readonly mode: Mode;
}

export const INITIAL: State = { v: 1, settings: DEFAULT_SETTINGS, mode: { kind: 'off' } };

/** Result of checking the scaffold file on disk; the session does the I/O. */
export type ScaffoldCheck = 'ok' | 'missingFile' | 'missingMarker';

export type Input =
  | { readonly type: 'on'; readonly settings: Settings }
  | { readonly type: 'off' }
  | { readonly type: 'write'; readonly write: CodeWrite }
  | { readonly type: 'register'; readonly exercise: Exercise; readonly check: ScaffoldCheck }
  | { readonly type: 'end' };

export type WriteOutcome =
  | { readonly type: 'allow' }
  | { readonly type: 'trigger'; readonly write: CodeWrite; readonly difficulty: Difficulty };

export type RegisterRefusal =
  | { readonly why: 'off' }
  | { readonly why: 'busy'; readonly current: Exercise }
  | { readonly why: 'missingFile' | 'missingMarker'; readonly path: DisplayPath };

export type RegisterOutcome =
  | { readonly type: 'ready'; readonly exercise: Exercise }
  | ({ readonly type: 'refused' } & RegisterRefusal);

interface OutcomeFor {
  on: { readonly type: 'on'; readonly settings: Settings };
  off: { readonly type: 'off' };
  write: WriteOutcome;
  register: RegisterOutcome;
  end: { readonly type: 'ended' };
}
export type Outcome<I extends Input = Input> = OutcomeFor[I['type']];

const idle = (count: number): Mode => ({ kind: 'idle', count });

function sameExercise(a: Exercise, b: Exercise): boolean {
  return a.unit === b.unit && a.path === b.path;
}

/** The whole state machine. Returns the identical State object when nothing changed. */
export function step<I extends Input>(s: State, input: I): readonly [State, Outcome<I>] {
  return stepAny(s, input) as readonly [State, Outcome<I>];
}

function stepAny(s: State, input: Input): readonly [State, Outcome] {
  const mode = s.mode;
  switch (input.type) {
    case 'on':
      return [{ ...s, settings: input.settings, mode: idle(0) }, { type: 'on', settings: input.settings }];
    case 'off':
      return [mode.kind === 'off' ? s : { ...s, mode: { kind: 'off' } }, { type: 'off' }];
    case 'write': {
      if (mode.kind !== 'idle') return [s, { type: 'allow' }];
      const next = mode.count + 1;
      if (next < s.settings.every) return [{ ...s, mode: idle(next) }, { type: 'allow' }];
      return [
        { ...s, mode: { kind: 'awaitingScaffold', trigger: input.write } },
        { type: 'trigger', write: input.write, difficulty: s.settings.difficulty },
      ];
    }
    case 'register': {
      if (mode.kind === 'off') return [s, { type: 'refused', why: 'off' }];
      if (mode.kind === 'active') {
        return sameExercise(mode.exercise, input.exercise)
          ? [s, { type: 'ready', exercise: mode.exercise }]
          : [s, { type: 'refused', why: 'busy', current: mode.exercise }];
      }
      if (input.check !== 'ok') {
        const refusal = { type: 'refused', why: input.check, path: input.exercise.path } as const;
        return [mode.kind === 'awaitingScaffold' ? { ...s, mode: idle(0) } : s, refusal];
      }
      return [{ ...s, mode: { kind: 'active', exercise: input.exercise } }, { type: 'ready', exercise: input.exercise }];
    }
    case 'end':
      if (mode.kind === 'off' || (mode.kind === 'idle' && mode.count === 0)) return [s, { type: 'ended' }];
      return [{ ...s, mode: idle(0) }, { type: 'ended' }];
  }
}

export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyi',
  'go',
  'rs',
  'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'awk', 'sed',
  'hs', 'elm', 'clj', 'cljs', 'erl', 'ex', 'exs', 'ml', 'fs', 'fsx',
  'php', 'rb', 'swift', 'dart', 'lua', 'r', 'pl', 't', 'pas', 'nim', 'zig', 'v', 'cr',
  'sql',
]);

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** One tool call counts once, even when a patch touches several files. */
export function toCodeWrite(root: ProjectRoot, raws: readonly RawWrite[]): CodeWrite | null {
  const hit = raws.find((w) => CODE_EXTENSIONS.has(extensionOf(w.path)));
  return hit ? { kind: hit.kind, path: displayPath(root, hit.path) } : null;
}

export function parseOnArgs(raw: string, current: Settings): Settings {
  let difficulty = current.difficulty;
  let every = current.every;
  const parts = raw.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isDifficulty(part)) difficulty = part;
    const value = parts[i + 1];
    if (part === '--every' && value) {
      every = toEvery(parseInt(value, 10)) ?? every;
      i++;
    }
  }
  return { difficulty, every };
}

export const COMMAND_NAMES = ['on', 'off', 'status', 'done', 'hint', 'solve', 'skip', 'rep'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export function isCommandName(s: unknown): s is CommandName {
  return typeof s === 'string' && (COMMAND_NAMES as readonly string[]).includes(s);
}

export type ExercisePromptName = 'done' | 'solve' | 'skip' | 'hint';

export type CommandOutcome =
  | {
      readonly kind: 'notice';
      readonly notice:
        | { readonly type: 'on'; readonly settings: Settings }
        | { readonly type: 'off' }
        | { readonly type: 'status'; readonly state: State };
    }
  | {
      readonly kind: 'prompt';
      readonly prompt:
        | { readonly type: ExercisePromptName; readonly exercise: Exercise }
        | { readonly type: 'skipScaffold'; readonly trigger: CodeWrite }
        | { readonly type: 'rep'; readonly difficulty: Difficulty };
    }
  | {
      readonly kind: 'refuse';
      readonly refusal:
        | { readonly why: 'off' }
        | { readonly why: 'noExercise'; readonly command: ExercisePromptName }
        | { readonly why: 'scaffoldPending'; readonly trigger: CodeWrite }
        | { readonly why: 'busy'; readonly current: Exercise };
    };

/** Pure. Only on, off and skip-while-awaiting change state. */
export function command(s: State, name: CommandName, args: string): readonly [State, CommandOutcome] {
  const mode = s.mode;
  const refuse = (refusal: Extract<CommandOutcome, { kind: 'refuse' }>['refusal']) =>
    [s, { kind: 'refuse', refusal }] as const;
  switch (name) {
    case 'on': {
      const [next, out] = step(s, { type: 'on', settings: parseOnArgs(args, s.settings) });
      return [next, { kind: 'notice', notice: out }];
    }
    case 'off':
      return [step(s, { type: 'off' })[0], { kind: 'notice', notice: { type: 'off' } }];
    case 'status':
      return [s, { kind: 'notice', notice: { type: 'status', state: s } }];
    case 'done':
    case 'solve':
    case 'hint':
    case 'skip':
      if (mode.kind === 'off') return refuse({ why: 'off' });
      if (mode.kind === 'idle') return refuse({ why: 'noExercise', command: name });
      if (mode.kind === 'active') return [s, { kind: 'prompt', prompt: { type: name, exercise: mode.exercise } }];
      return name === 'skip'
        ? [{ ...s, mode: idle(0) }, { kind: 'prompt', prompt: { type: 'skipScaffold', trigger: mode.trigger } }]
        : refuse({ why: 'scaffoldPending', trigger: mode.trigger });
    case 'rep':
      if (mode.kind === 'off') return refuse({ why: 'off' });
      if (mode.kind === 'active') return refuse({ why: 'busy', current: mode.exercise });
      return [s, { kind: 'prompt', prompt: { type: 'rep', difficulty: s.settings.difficulty } }];
  }
}
