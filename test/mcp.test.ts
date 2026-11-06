import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMcpHandler } from '../src/mcp.ts';
import { sandbox } from './helpers.ts';

function handler() {
  const box = sandbox();
  return { box, handle: createMcpHandler({ harness: 'droid', rootFlag: box.root, env: box.env, cwd: '/', version: '9.9.9' }) };
}

const call = (id: number, name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize negotiates a known protocol version and carries the skill as instructions', async () => {
  const { handle } = handler();
  const known = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as { result: Record<string, unknown> };
  assert.equal(known.result.protocolVersion, '2025-03-26');
  assert.deepEqual(known.result.serverInfo, { name: 'spotme', version: '9.9.9' });
  assert.match(String(known.result.instructions), /SpotMe — Gym Mode/);
  assert.match(String(known.result.instructions), /the Create or Edit tool/, 'instructions use the harness vocabulary');
  const future = (await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })) as { result: Record<string, unknown> };
  assert.equal(future.result.protocolVersion, '2025-06-18');
});

test('tools/list exposes the four SpotMe tools with JSON schemas', async () => {
  const { handle } = handler();
  const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
  assert.deepEqual(res.result.tools.map((t) => t.name), ['spotme_exercise', 'spotme_status', 'spotme_end', 'spotme_command']);
  assert.ok(res.result.tools.every((t) => t.inputSchema.type === 'object'));
});

test('tools/call runs against the baked root and reports refusals as tool errors', async () => {
  const { handle, box } = handler();
  const on = (await handle(call(1, 'spotme_command', { name: 'on', args: '--every 1' }))) as { result: { content: { text: string }[]; isError: boolean } };
  assert.equal(on.result.isError, false);
  assert.match(on.result.content[0]!.text, /SpotMe is on/);
  const missing = (await handle(call(2, 'spotme_exercise', { unit: 'U', filePath: 'u.ts', difficulty: 'medium' }))) as { result: { isError: boolean } };
  assert.equal(missing.result.isError, true);
  writeFileSync(join(box.root, 'u.ts'), '// SPOTME: implement u\n');
  const ready = (await handle(call(3, 'spotme_exercise', { unit: 'U', filePath: 'u.ts', difficulty: 'medium' }))) as { result: { content: { text: string }[] } };
  assert.match(ready.result.content[0]!.text, /`\/spotme:done`/);
});

test('notifications get no response and unknown methods get -32601', async () => {
  const { handle } = handler();
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(await handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' }), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32601, message: 'Method not found: resources/list' },
  });
  assert.deepEqual(await handle({ jsonrpc: '2.0', id: 8, method: 'ping' }), { jsonrpc: '2.0', id: 8, result: {} });
});
