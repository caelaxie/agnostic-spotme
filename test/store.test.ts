import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { INITIAL, step, toEvery } from '../src/engine.ts';
import type { State } from '../src/engine.ts';
import { canonicalRoot, LockTimeout, openStore, parseDoc, stateDir, stateKey } from '../src/store.ts';
import { sandbox, tempDir } from './helpers.ts';

const on = (every: number): State => ({ ...INITIAL, settings: { difficulty: 'medium', every: toEvery(every)! }, mode: { kind: 'idle', count: 0 } });
const write = (path: string) => ({ type: 'write', write: { kind: 'create', path } }) as const;

test('canonicalRoot resolves symlinks and climbs to the nearest .git', () => {
  const { root } = sandbox();
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  assert.equal(canonicalRoot(join(root, 'src', 'deep')), root);
  const plain = tempDir();
  assert.equal(canonicalRoot(plain).endsWith(plain.split('/').pop()!), true);
});

test('stateDir honours SPOTME_STATE_DIR, then XDG_STATE_HOME, then HOME', () => {
  assert.equal(stateDir({ SPOTME_STATE_DIR: '/x' }), '/x');
  assert.equal(stateDir({ XDG_STATE_HOME: '/s' }), '/s/spotme');
  assert.equal(stateDir({ HOME: '/h' }), '/h/.local/state/spotme');
});

test('state files are keyed by the full sha256 of the root', () => {
  const { root, stateDir: dir } = sandbox();
  const store = openStore(root, { dir });
  assert.match(stateKey(root), /^[0-9a-f]{64}$/);
  assert.equal(store.file, join(dir, `${stateKey(root)}.json`));
});

test('a missing document reads as INITIAL and transact persists changes', async () => {
  const { root, stateDir: dir } = sandbox();
  const store = openStore(root, { dir });
  assert.deepEqual(await store.read(), INITIAL);
  await store.transact(() => [on(3), null]);
  assert.deepEqual((await store.read()).mode, { kind: 'idle', count: 0 });
  const doc = JSON.parse(readFileSync(store.file, 'utf8'));
  assert.equal(doc.root, root);
});

test('an unchanged state is not rewritten', async () => {
  const { root, stateDir: dir } = sandbox();
  const store = openStore(root, { dir });
  await store.transact((s) => [s, null]);
  assert.equal(existsSync(store.file), false);
});

test('twenty concurrent writers through separate store handles lose no update', async () => {
  const { root, stateDir: dir } = sandbox();
  await openStore(root, { dir }).transact(() => [on(25), null]);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => openStore(root, { dir }).transact((s) => step(s, write(`f${i}.ts` as never)))),
  );
  assert.deepEqual((await openStore(root, { dir }).read()).mode, { kind: 'idle', count: 20 });
  assert.deepEqual(
    readdirSync(dir).filter((f) => !f.endsWith('.json')),
    [],
    'no lock, tombstone or temp file is left behind',
  );
});

test('a lock left by a dead process on this host is broken', async () => {
  const { root, stateDir: dir } = sandbox();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${stateKey(root)}.lock`);
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), token: 'dead', at: Date.now() }));
  const started = Date.now();
  await openStore(root, { dir, lockTimeoutMs: 1000 }).transact(() => [on(2), null]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(existsSync(lock), false);
});

test('a lock older than the stale window is broken even when its owner looks alive', async () => {
  const { root, stateDir: dir } = sandbox();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${stateKey(root)}.lock`);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'elsewhere', token: 'old', at: Date.now() - 60_000 }));
  await openStore(root, { dir, lockTimeoutMs: 1000 }).transact(() => [on(2), null]);
  assert.equal((await openStore(root, { dir }).read()).mode.kind, 'idle');
});

test('a fresh lock held by a live process times out', async () => {
  const { root, stateDir: dir } = sandbox();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stateKey(root)}.lock`), JSON.stringify({ pid: process.pid, host: hostname(), token: 'live', at: Date.now() }));
  await assert.rejects(openStore(root, { dir, lockTimeoutMs: 100 }).transact(() => [on(2), null]), LockTimeout);
});

test('a corrupt document reads as INITIAL and is quarantined on the next write', async () => {
  const { root, stateDir: dir } = sandbox();
  const store = openStore(root, { dir });
  mkdirSync(dir, { recursive: true });
  writeFileSync(store.file, '{ not json');
  assert.deepEqual(await store.read(), INITIAL);
  await store.transact(() => [on(2), null]);
  assert.equal(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1);
  assert.equal((await store.read()).mode.kind, 'idle');
});

test('parseDoc rejects unknown versions and clamps an out-of-range counter', () => {
  const state = { v: 1, settings: { difficulty: 'hard', every: 3 }, mode: { kind: 'idle', count: 9 } };
  assert.deepEqual(parseDoc({ v: 1, root: '/r', state })?.mode, { kind: 'idle', count: 2 });
  assert.equal(parseDoc({ v: 2, root: '/r', state }), null);
  assert.equal(parseDoc({ v: 1, state: { ...state, settings: { difficulty: 'extreme', every: 3 } } }), null);
  assert.equal(parseDoc({ v: 1, state: { ...state, mode: { kind: 'active', exercise: { unit: 'u' } } } }), null);
});
