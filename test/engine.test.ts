import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  command,
  DEFAULT_SETTINGS,
  INITIAL,
  parseOnArgs,
  step,
  toCodeWrite,
  toEvery,
  type CodeWrite,
  type DisplayPath,
  type Exercise,
  type Mode,
  type ProjectRoot,
  type Settings,
  type State,
} from '../src/engine.ts';
import { renderCommand, renderReady, renderStatus, renderWriteDenial, type Vocab } from '../src/messages.ts';

const root = '/repo' as ProjectRoot;
const p = (s: string) => s as DisplayPath;
const every = (n: number) => toEvery(n)!;
const settings = (n: number, difficulty: Settings['difficulty'] = 'medium'): Settings => ({ difficulty, every: every(n) });
const at = (mode: Mode, n = 2): State => ({ v: 1, settings: settings(n), mode });
const write: CodeWrite = { kind: 'create', path: p('src/a.ts') };
const exercise: Exercise = { unit: 'add', path: p('src/a.ts'), difficulty: 'medium' };
const other: Exercise = { unit: 'sub', path: p('src/b.ts'), difficulty: 'medium' };
const OFF: Mode = { kind: 'off' };
const IDLE0: Mode = { kind: 'idle', count: 0 };
const IDLE1: Mode = { kind: 'idle', count: 1 };
const AWAIT: Mode = { kind: 'awaitingScaffold', trigger: write };
const ACTIVE: Mode = { kind: 'active', exercise };
const colon: Vocab = { command: (n) => `/spotme:${n}`, writeTool: 'Create', editTool: 'Edit' };
const dash: Vocab = { command: (n) => `/spotme-${n}`, writeTool: 'Write', editTool: 'Write' };

describe('step: write', () => {
  const cases: Array<[string, Mode, number, string, Mode['kind'], number | undefined]> = [
    ['off ignores writes', OFF, 2, 'allow', 'off', undefined],
    ['idle 0/2 counts', IDLE0, 2, 'allow', 'idle', 1],
    ['idle 1/2 triggers', IDLE1, 2, 'trigger', 'awaitingScaffold', undefined],
    ['idle 0/1 triggers on the first write', IDLE0, 1, 'trigger', 'awaitingScaffold', undefined],
    ['awaitingScaffold bypasses', AWAIT, 2, 'allow', 'awaitingScaffold', undefined],
    ['active bypasses', ACTIVE, 2, 'allow', 'active', undefined],
  ];
  for (const [name, mode, n, outcome, kind, count] of cases) {
    test(name, () => {
      const [next, out] = step(at(mode, n), { type: 'write', write });
      assert.equal(out.type, outcome);
      assert.equal(next.mode.kind, kind);
      if (count !== undefined) assert.deepEqual(next.mode, { kind: 'idle', count });
    });
  }

  test('a no-op returns the identical state object', () => {
    const s = at(ACTIVE);
    assert.equal(step(s, { type: 'write', write })[0], s);
  });

  test('every N-th write triggers and the count stays below every', () => {
    for (const n of [1, 2, 3, 5]) {
      let s = at(IDLE0, n);
      const triggers: number[] = [];
      for (let i = 1; i <= n * 3; i++) {
        const [next, out] = step(s, { type: 'write', write });
        if (out.type === 'trigger') {
          triggers.push(i);
          s = step(next, { type: 'end' })[0];
        } else {
          s = next;
        }
        if (s.mode.kind === 'idle') assert.ok(s.mode.count < n);
      }
      assert.deepEqual(triggers, [n, 2 * n, 3 * n]);
    }
  });

  test('the trigger carries the write and the difficulty', () => {
    const [, out] = step({ ...at(IDLE1), settings: settings(2, 'hard') }, { type: 'write', write });
    assert.deepEqual(out, { type: 'trigger', write, difficulty: 'hard' });
  });
});

describe('step: on/off/end', () => {
  for (const mode of [OFF, IDLE1, AWAIT, ACTIVE]) {
    test(`on from ${mode.kind} resets to idle(0) with new settings`, () => {
      const [next] = step(at(mode), { type: 'on', settings: settings(3, 'lite') });
      assert.deepEqual(next, { v: 1, settings: settings(3, 'lite'), mode: IDLE0 });
    });
    test(`off from ${mode.kind} keeps settings`, () => {
      const [next] = step(at(mode, 4), { type: 'off' });
      assert.deepEqual(next, { v: 1, settings: settings(4), mode: OFF });
    });
  }
  test('end from active, awaitingScaffold and idle resets to idle(0)', () => {
    for (const mode of [ACTIVE, AWAIT, IDLE1]) {
      assert.deepEqual(step(at(mode), { type: 'end' })[0].mode, IDLE0);
    }
  });
  test('end while off stays off', () => {
    const s = at(OFF);
    assert.equal(step(s, { type: 'end' })[0], s);
  });
});

describe('step: register', () => {
  test('from awaitingScaffold with a valid scaffold becomes active', () => {
    const [next, out] = step(at(AWAIT), { type: 'register', exercise, check: 'ok' });
    assert.deepEqual(next.mode, ACTIVE);
    assert.deepEqual(out, { type: 'ready', exercise });
  });
  test('from idle (rep) becomes active', () => {
    const [next] = step(at(IDLE1), { type: 'register', exercise, check: 'ok' });
    assert.deepEqual(next.mode, ACTIVE);
  });
  for (const check of ['missingFile', 'missingMarker'] as const) {
    test(`failed registration (${check}) from awaitingScaffold recovers to idle(0)`, () => {
      const [next, out] = step(at(AWAIT), { type: 'register', exercise, check });
      assert.deepEqual(next.mode, IDLE0);
      assert.deepEqual(out, { type: 'refused', why: check, path: exercise.path });
    });
  }
  test('failed registration from idle leaves the count alone', () => {
    const s = at(IDLE1);
    assert.equal(step(s, { type: 'register', exercise, check: 'missingFile' })[0], s);
  });
  test('while off is refused', () => {
    assert.deepEqual(step(at(OFF), { type: 'register', exercise, check: 'ok' })[1], { type: 'refused', why: 'off' });
  });
  test('the same exercise while active is ready again', () => {
    assert.deepEqual(step(at(ACTIVE), { type: 'register', exercise, check: 'ok' })[1], { type: 'ready', exercise });
  });
  test('a different exercise while active is refused as busy', () => {
    const s = at(ACTIVE);
    const [next, out] = step(s, { type: 'register', exercise: other, check: 'ok' });
    assert.equal(next, s);
    assert.deepEqual(out, { type: 'refused', why: 'busy', current: exercise });
  });
});

describe('command', () => {
  const text = (mode: Mode, name: Parameters<typeof command>[1], args = '', v: Vocab = colon) => {
    const [next, out] = command(at(mode), name, args);
    return { next, out, text: renderCommand(out, root, v) };
  };

  test('on parses args with current settings as defaults', () => {
    const r = text(OFF, 'on', 'hard --every 3');
    assert.deepEqual(r.next, { v: 1, settings: settings(3, 'hard'), mode: IDLE0 });
    assert.equal(r.text, '🏋️ SpotMe is on. Difficulty: hard. Triggering every 3 code write(s).');
  });
  test('off', () => {
    const r = text(ACTIVE, 'off');
    assert.equal(r.next.mode.kind, 'off');
    assert.equal(r.text, '⏹️ SpotMe is off — normal coding resumed.');
  });

  const refusals: Array<[Mode, Parameters<typeof command>[1], string]> = [
    [IDLE0, 'done', 'No active SpotMe exercise to review.'],
    [IDLE0, 'solve', 'No active SpotMe exercise to solve.'],
    [IDLE0, 'skip', 'No active SpotMe exercise to skip.'],
    [IDLE0, 'hint', 'No active SpotMe exercise to give a hint for.'],
    [OFF, 'done', 'SpotMe is off. Run /spotme:on first.'],
    [OFF, 'rep', 'SpotMe is off. Run /spotme:on first.'],
    [AWAIT, 'done', 'The exercise scaffold at src/a.ts is not registered yet. Let the agent finish it, or run /spotme:skip to cancel it.'],
    [ACTIVE, 'rep', 'An exercise is already active: add (src/a.ts). Finish it with /spotme:done, /spotme:solve, /spotme:skip first.'],
  ];
  for (const [mode, name, expected] of refusals) {
    test(`${name} while ${mode.kind} is refused locally`, () => {
      const r = text(mode, name);
      assert.equal(r.out.kind, 'refuse');
      assert.equal(r.text, expected);
      assert.deepEqual(r.next, at(mode));
    });
  }

  test('done while active injects the exercise', () => {
    const r = text(ACTIVE, 'done');
    assert.equal(r.out.kind, 'prompt');
    assert.match(r.text, /^Current SpotMe exercise: \*\*add\*\* in `src\/a\.ts`\./);
    assert.match(r.text, /Call `spotme_end` as the LAST thing you do\.$/);
  });
  test('skip from awaitingScaffold closes it', () => {
    const r = text(AWAIT, 'skip');
    assert.equal(r.out.kind, 'prompt');
    assert.deepEqual(r.next.mode, IDLE0);
    assert.match(r.text, /Do not call `spotme_exercise`/);
  });
  test('rep from idle prompts with the session difficulty and the harness write tool', () => {
    const r = text(IDLE1, 'rep', '', dash);
    assert.equal(r.out.kind, 'prompt');
    assert.match(r.text, /using the Write tool/);
    assert.match(r.text, /difficulty "medium"\.$/);
  });
  test('status shows the pending scaffold', () => {
    const r = text(AWAIT, 'status');
    assert.equal(
      r.text,
      [
        'SpotMe: 🟢 on',
        'Difficulty: medium',
        'Trigger every: 2 code write(s)',
        'Counter: 0/2',
        'Pending scaffold: src/a.ts (waiting for spotme_exercise)',
        'Project: /repo',
      ].join('\n'),
    );
  });
  test('status shows the active exercise and the live counter', () => {
    assert.match(renderStatus(at(ACTIVE), root), /Active exercise: add \(src\/a\.ts\)/);
    assert.match(renderStatus(at(IDLE1, 3), root), /Counter: 1\/3/);
    assert.match(renderStatus(INITIAL, root), /^SpotMe: ⚪ off/);
  });
});

describe('messages', () => {
  test('ready message uses the file comment marker and harness command names', () => {
    const py = renderReady({ unit: 'tax', path: p('calc.py'), difficulty: 'lite' }, dash);
    assert.match(py, /Replace the `# SPOTME:` marker/);
    assert.match(py, /`\/spotme-hint`  — get a targeted hint/);
    assert.match(py, /`\/spotme-solve` — concede/);
    assert.match(renderReady(exercise, colon), /Replace the `\/\/ SPOTME:` marker/);
    assert.match(renderReady({ ...exercise, path: p('a.html') }, colon), /Replace the `<!-- SPOTME:` marker/);
    assert.match(renderReady(exercise, colon), /^🏋️ Exercise ready: \*\*add\*\*\nDifficulty: medium — signature provided — implement the logic\nFile: `src\/a\.ts`/);
  });
  test('trigger denial names the harness write tool and the marker syntax', () => {
    const t = renderWriteDenial({ type: 'trigger', write: { kind: 'create', path: p('x.sql') }, difficulty: 'hard' }, colon);
    assert.match(t, /^\[SpotMe\] Counter reached — time for an exercise!/);
    assert.match(t, /Write the scaffold to `x\.sql` using the Create tool\. Include a `-- SPOTME: <description>` comment/);
    assert.match(t, /difficulty "hard"/);
    const e = renderWriteDenial({ type: 'trigger', write: { kind: 'edit', path: p('a.css') }, difficulty: 'lite' }, colon);
    assert.match(e, /Edit `a\.css` to add a `\/\* SPOTME: <description> \*\/` comment/);
  });
});

describe('parsing', () => {
  test('parseOnArgs', () => {
    assert.deepEqual(parseOnArgs('', DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    assert.deepEqual(parseOnArgs('lite', DEFAULT_SETTINGS), settings(2, 'lite'));
    assert.deepEqual(parseOnArgs('--every 0 hard', DEFAULT_SETTINGS), settings(2, 'hard'));
    assert.deepEqual(parseOnArgs('--every 7', settings(3, 'hard')), settings(7, 'hard'));
    assert.deepEqual(parseOnArgs('--every x', settings(3)), settings(3));
  });
  test('toCodeWrite filters non-code files and maps paths to the root', () => {
    assert.equal(toCodeWrite(root, [{ kind: 'create', path: '/repo/README.md' }]), null);
    assert.equal(toCodeWrite(root, [{ kind: 'create', path: '/repo/Makefile' }]), null);
    assert.deepEqual(toCodeWrite(root, [{ kind: 'edit', path: '/repo/docs/x.md' }, { kind: 'create', path: '/repo/src/A.TS' }]), {
      kind: 'create',
      path: 'src/A.TS',
    });
    assert.deepEqual(toCodeWrite(root, [{ kind: 'edit', path: '/elsewhere/b.py' }]), { kind: 'edit', path: '/elsewhere/b.py' });
    assert.deepEqual(toCodeWrite(root, [{ kind: 'edit', path: 'rel/c.go' }]), { kind: 'edit', path: 'rel/c.go' });
  });
});
