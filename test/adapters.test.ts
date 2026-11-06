import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spotmePlugin } from '../src/opencode.ts';
import type { OpenCodeToolCall } from '../src/opencode.ts';
import spotme from '../src/pi.ts';
import { openSpotMe } from '../src/session.ts';
import { HARNESSES } from '../src/harnesses.ts';
import { sandbox } from './helpers.ts';

type Handler = (...args: never[]) => unknown;

function fakePi() {
  const tools = new Map<string, { execute: Handler; parameters: unknown }>();
  const commands = new Map<string, { handler: Handler }>();
  const events = new Map<string, Handler>();
  const sent: string[] = [];
  const notes: [string, string][] = [];
  const api = {
    registerTool: (t: { name: string; execute: Handler; parameters: unknown }) => tools.set(t.name, t),
    registerCommand: (name: string, c: { handler: Handler }) => commands.set(name, c),
    on: (event: string, h: Handler) => events.set(event, h),
    sendUserMessage: (text: string) => sent.push(text),
  };
  return { api, tools, commands, events, sent, notes, ui: { notify: (m: string, t: string) => notes.push([m, t]) } };
}

test('Pi: registers the tools and commands, runs state commands locally and blocks the Nth write', async () => {
  const box = sandbox();
  const saved = process.env.SPOTME_STATE_DIR;
  process.env.SPOTME_STATE_DIR = box.stateDir;
  try {
    const pi = fakePi();
    spotme(pi.api as never);
    assert.deepEqual([...pi.tools.keys()], ['spotme_exercise', 'spotme_status', 'spotme_end', 'spotme_command']);
    assert.ok([...pi.commands.keys()].every((n) => n.startsWith('spotme:')));
    const ctx = { cwd: box.root, ui: pi.ui };
    const run = (name: string, args = '') => (pi.commands.get(`spotme:${name}`)!.handler as (a: string, c: unknown) => Promise<void>)(args, ctx);
    const toolCall = pi.events.get('tool_call') as (e: unknown, c: unknown) => Promise<unknown>;

    await run('on', '--every 2');
    assert.match(pi.notes.at(-1)![0], /SpotMe is on/);
    await run('done');
    assert.deepEqual(pi.notes.at(-1), ['No active SpotMe exercise to review.', 'warning']);

    assert.equal(await toolCall({ toolName: 'write', input: { path: join(box.root, 'a.ts'), content: '' } }, ctx), undefined);
    const blocked = (await toolCall({ toolName: 'edit', input: { path: 'b.ts', edits: [] } }, ctx)) as { block: boolean; reason: string };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /1\. Edit `b\.ts`/);

    writeFileSync(join(box.root, 'b.ts'), '// SPOTME: do it\n');
    const exec = pi.tools.get('spotme_exercise')!.execute as (...a: unknown[]) => Promise<{ content: { text: string }[] }>;
    const ready = await exec('id', { unit: 'B', filePath: 'b.ts', difficulty: 'medium' }, undefined, undefined, ctx);
    assert.match(ready.content[0]!.text, /`\/spotme:hint`/);
    await run('solve');
    assert.match(pi.sent.at(-1)!, /^Current SpotMe exercise: \*\*B\*\* in `b\.ts`/);
  } finally {
    if (saved === undefined) delete process.env.SPOTME_STATE_DIR;
    else process.env.SPOTME_STATE_DIR = saved;
  }
});

test('OpenCode: the execute.before hook rejects the Nth code write with the scaffold instructions', async () => {
  const box = sandbox();
  let hook: ((call: OpenCodeToolCall) => Promise<void>) | undefined;
  const plugin = spotmePlugin({ root: box.root, stateDir: box.stateDir });
  assert.equal(plugin.id, 'spotme');
  await plugin.setup({ location: { directory: '/elsewhere' }, tool: { hook: (_name, cb) => (hook = cb) } });
  await openSpotMe(box.root, HARNESSES.opencode.vocab, { env: box.env }).command('on', '--every 2');
  await hook!({ tool: 'write', input: { path: join(box.root, 'a.ts'), content: '' } });
  await hook!({ tool: 'read', input: { path: join(box.root, 'a.ts') } });
  await assert.rejects(hook!({ tool: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: c.go\n+package c\n*** End Patch' } }), /Write the scaffold to `c\.go` using the write tool/);
});
