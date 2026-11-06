import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSpotMe, toJsonSchema, TOOLS } from '../src/session.ts';
import type { Store } from '../src/store.ts';
import type { Vocab } from '../src/messages.ts';
import { sandbox } from './helpers.ts';

const GENERIC_VOCAB: Vocab = { command: (n) => `/spotme:${n}`, writeTool: 'Write', editTool: 'Edit' };

const create = (path: string) => [{ kind: 'create', path }] as const;

function fresh() {
  const box = sandbox();
  return { ...box, sm: openSpotMe(box.root, GENERIC_VOCAB, { env: box.env }) };
}

test('writes pass while SpotMe is off and for non-code files', async () => {
  const { sm } = fresh();
  assert.deepEqual(await sm.onWrite(create('a.ts')), { allow: true });
  await sm.command('on', '--every 1');
  assert.deepEqual(await sm.onWrite(create('README.md')), { allow: true });
});

test('the Nth code write is denied with scaffold instructions, then writes pass until registration', async () => {
  const { sm } = fresh();
  await sm.command('on', 'hard --every 2');
  assert.deepEqual(await sm.onWrite(create('a.ts')), { allow: true });
  const denied = await sm.onWrite(create('src/b.py'));
  assert.equal(denied.allow, false);
  assert.match(denied.allow ? '' : denied.reason, /# SPOTME: <description>/);
  assert.match(denied.allow ? '' : denied.reason, /difficulty "hard"/);
  assert.deepEqual(await sm.onWrite(create('src/b.py')), { allow: true }, 'the scaffold write itself goes through');
  assert.match((await sm.callTool('spotme_status', {})).text, /Pending scaffold: src\/b\.py/);
});

test('registration checks the scaffold on disk', async () => {
  const { sm, root } = fresh();
  await sm.command('on', '--every 1');
  await sm.onWrite(create('unit.ts'));
  const missing = await sm.callTool('spotme_exercise', { unit: 'U', filePath: 'unit.ts', difficulty: 'medium' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /not found/);
  assert.match((await sm.callTool('spotme_status', {})).text, /Counter: 0\/1/, 'a failed registration abandons the trigger');

  writeFileSync(join(root, 'unit.ts'), 'export function f() {}\n');
  assert.match((await sm.callTool('spotme_exercise', { unit: 'U', filePath: 'unit.ts', difficulty: 'medium' })).text, /no SPOTME: marker/);

  writeFileSync(join(root, 'unit.ts'), 'export function f() {\n  // SPOTME: implement f\n}\n');
  const ready = await sm.callTool('spotme_exercise', { unit: 'U', filePath: join(root, 'unit.ts'), difficulty: 'medium' });
  assert.equal(ready.ok, true);
  assert.match(ready.text, /Exercise ready: \*\*U\*\*/);
  assert.match((await sm.callTool('spotme_status', {})).text, /Active exercise: U \(unit\.ts\)/);
  assert.deepEqual(await sm.onWrite(create('other.ts')), { allow: true }, 'writes are not counted during an exercise');
});

test('spotme_command relays notices verbatim and returns prompts as instructions', async () => {
  const { sm } = fresh();
  const on = await sm.callTool('spotme_command', { name: 'on', args: 'lite' });
  assert.equal(on.ok, true);
  assert.match(on.text, /^Show the following to the user verbatim/);
  assert.match(on.text, /Difficulty: lite/);
  const rep = await sm.callTool('spotme_command', { name: 'rep' });
  assert.match(rep.text, /^The human wants a coding exercise/);
  const done = await sm.callTool('spotme_command', { name: 'done' });
  assert.equal(done.ok, true, 'a refusal is still a successful relay');
  assert.match(done.text, /No active SpotMe exercise to review/);
});

test('peekCommand predicts without changing state', async () => {
  const { sm } = fresh();
  await sm.command('on', '--every 1');
  await sm.onWrite(create('x.ts'));
  assert.equal(await sm.peekCommand('skip', ''), 'prompt');
  assert.match((await sm.callTool('spotme_status', {})).text, /Pending scaffold/);
  assert.equal((await sm.command('skip', '')).kind, 'prompt');
  assert.match((await sm.callTool('spotme_status', {})).text, /Counter: 0\/1/);
});

test('tool arguments are validated at the boundary', async () => {
  const { sm } = fresh();
  assert.deepEqual(await sm.callTool('nope', {}), { ok: false, text: 'Unknown SpotMe tool: nope' });
  assert.match((await sm.callTool('spotme_exercise', { unit: 'U' })).text, /Missing required argument: filePath/);
  assert.match((await sm.callTool('spotme_exercise', { unit: 'U', filePath: 'a', difficulty: 'max' })).text, /must be one of/);
  assert.match((await sm.callTool('spotme_command', { name: 'explode' })).text, /must be one of/);
});

test('spotme_end returns to a fresh counter', async () => {
  const { sm } = fresh();
  await sm.command('on', '--every 3');
  await sm.onWrite(create('a.ts'));
  await sm.callTool('spotme_end', {});
  assert.match((await sm.callTool('spotme_status', {})).text, /Counter: 0\/3/);
});

test('a broken store fails open', async () => {
  const { root } = sandbox();
  const lines: string[] = [];
  const store: Store = {
    file: '/dev/null',
    read: async () => ({ v: 1, settings: { difficulty: 'medium', every: 1 as never }, mode: { kind: 'idle', count: 0 } }),
    transact: async () => {
      throw new Error('disk on fire');
    },
  };
  const sm = openSpotMe(root, GENERIC_VOCAB, { store, log: (l) => lines.push(l) });
  assert.deepEqual(await sm.onWrite(create('a.ts')), { allow: true });
  assert.match(lines.join('\n'), /disk on fire/);
});

test('tool schemas list required parameters and enums', () => {
  const schema = toJsonSchema(TOOLS.spotme_command);
  assert.deepEqual(schema.required, ['name']);
  assert.deepEqual((schema.properties as Record<string, { enum?: string[] }>).name?.enum?.includes('skip'), true);
});
