import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { main } from '../src/cli.ts';
import type { Io } from '../src/cli.ts';
import { openStore } from '../src/store.ts';
import { sandbox } from './helpers.ts';
import type { Sandbox } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs');
const run = promisify(execFile);
const call = (id: number, name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function bundle(): string {
  assert.ok(existsSync(CLI), 'dist/cli.mjs is missing; run `npm run build`');
  return CLI;
}

function hookChild(box: Sandbox, payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle(), 'hook', 'droid', 'write', '--root', box.root], { env: box.env });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`hook exited ${code}`))));
    child.stdin.end(JSON.stringify(payload));
  });
}

const create = (box: Sandbox, i: number) => ({
  hook_event_name: 'PreToolUse',
  cwd: box.root,
  tool_name: 'Create',
  tool_input: { file_path: join(box.root, `f${i}.ts`), content: '' },
});

async function cli(box: Sandbox, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { stdin: (async function* () {})(), out: (t) => (out += t), err: (t) => (err += t), cwd: box.root };
  const code = await main(argv, { ...box.env }, io);
  return { code, out, err };
}

test('twenty concurrent hook processes count every write exactly once', async () => {
  const box = sandbox();
  await cli(box, 'on', '--every', '21');
  const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => hookChild(box, create(box, i))));
  assert.deepEqual(new Set(outs), new Set(['']));
  assert.deepEqual((await openStore(box.root, { dir: box.stateDir }).read()).mode, { kind: 'idle', count: 20 });
});

test('twenty concurrent hook processes at every=5 produce exactly one denial', async () => {
  const box = sandbox();
  await cli(box, 'on', '--every', '5');
  const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => hookChild(box, create(box, i))));
  assert.equal(outs.filter((o) => o.includes('"permissionDecision":"deny"')).length, 1);
  assert.equal((await openStore(box.root, { dir: box.stateDir }).read()).mode.kind, 'awaitingScaffold');
});

test('CLI commands share state with hooks and can relay for a model', async () => {
  const box = sandbox();
  assert.match((await cli(box, 'on', 'hard', '--every', '3')).out, /Difficulty: hard\. Triggering every 3/);
  assert.match((await cli(box, 'status', '--harness', 'cursor')).out, /Counter: 0\/3/);
  assert.match((await cli(box, 'status', '--for-model')).out, /^Show the following to the user verbatim/);
  assert.match((await cli(box, 'rep', '--harness', 'codex')).out, /using the apply_patch tool/);
  const bad = await cli(box, 'exercise', '--unit', 'U', '--file', 'missing.ts', '--difficulty', 'hard');
  assert.equal(bad.code, 1);
  assert.equal((await cli(box, 'explode')).code, 2);
  assert.equal((await cli(box, '--version')).out.trim(), JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
});

test('install --dry-run writes nothing', async () => {
  const box = sandbox();
  const r = await cli(box, 'install', 'droid', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would create\s+.*\.factory\/hooks\.json/);
  assert.equal(existsSync(join(box.root, '.factory')), false);
  assert.equal(existsSync(join(box.env.XDG_DATA_HOME!, 'spotme')), false);
});

test('doctor lists an installed Antigravity project', async () => {
  const box = sandbox();
  const install = await cli(box, 'install', 'antigravity', '--root', box.root, '--state-dir', box.stateDir);
  assert.equal(install.code, 0, install.err);
  const doctor = await cli(box, 'doctor', '--root', box.root, '--state-dir', box.stateDir);
  assert.equal(doctor.code, 0, doctor.out + doctor.err);
  assert.match(doctor.out, /^antigravity\s+.*PATH; project installed, user absent$/m);
});

test('the installed hook command runs from the stable runtime copy and denies at the trigger', async () => {
  const box = sandbox();
  const install = await run(process.execPath, [bundle(), 'install', 'droid', '--root', box.root, '--state-dir', box.stateDir], { env: box.env });
  assert.match(install.stdout, /create\s+.*spotme\/runtime\/cli\.mjs/);
  const hooks = JSON.parse(readFileSync(join(box.root, '.factory', 'hooks.json'), 'utf8'));
  const command: string = hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /spotme\/runtime\/cli\.mjs hook droid write/);

  await cli(box, 'on', '--every', '1');
  const started = Date.now();
  const shell = spawn('/bin/sh', ['-c', command], { env: { PATH: box.env.PATH }, cwd: '/' });
  let out = '';
  shell.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  shell.stdin.end(JSON.stringify(create(box, 1)));
  await new Promise((resolve) => shell.on('close', resolve));
  assert.match(out, /"permissionDecision":"deny"/, 'state dir and root were baked into the command');
  assert.ok(Date.now() - started < 2000, `hook took ${Date.now() - started}ms`);

  const again = await run(process.execPath, [bundle(), 'install', 'droid', '--root', box.root, '--state-dir', box.stateDir], { env: box.env });
  assert.doesNotMatch(again.stdout, /\b(create|update)\b/, 'a second install is a no-op');
  const doctor = await run(process.execPath, [bundle(), 'doctor', '--root', box.root, '--state-dir', box.stateDir], { env: box.env });
  assert.match(doctor.stdout, /^droid .*project installed/m);
});
test('the stdio server answers a scripted session in order and exits on EOF', async () => {
  const box = sandbox();
  const child = spawn(process.execPath, [bundle(), 'mcp', '--harness', 'codex', '--root', box.root], { env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    call(2, 'spotme_status'),
    'garbage',
  ];
  child.stdin.end(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l) as { id: unknown; result?: { content?: { text: string }[] }; error?: { code: number } });
  assert.deepEqual(replies.map((r) => r.id), [1, 2, null]);
  assert.match(replies[1]!.result!.content![0]!.text, /SpotMe: ⚪ off/);
  assert.equal(replies[2]!.error!.code, -32700);
});
