import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCommandName } from '../src/engine.ts';
import { extractWrites, parsePatch, parsePromptCommand, writeMatcher } from '../src/harness.ts';
import type { HookEvent } from '../src/harness.ts';
import { HARNESSES } from '../src/harnesses.ts';
import type { HarnessId } from '../src/harnesses.ts';
import { runHook } from '../src/hook.ts';
import { commandFileBody } from '../src/messages.ts';
import { openSpotMe } from '../src/session.ts';
import { sandbox } from './helpers.ts';

interface Fixture {
  readonly source: 'measured' | 'measured-shape' | 'doc';
  readonly event: HookEvent;
  readonly stdin: unknown;
  readonly expect: {
    readonly writes?: readonly { kind: string; path: string }[];
    readonly code?: boolean;
    readonly command?: { name: string; args: string };
  };
}

const FIXTURES = join(import.meta.dirname, 'fixtures');

const REQUIRED: Readonly<Partial<Record<HarnessId, readonly string[]>>> = {
  droid: ['create', 'edit', 'apply-patch', 'execute-ignored'],
  claude: ['write', 'edit', 'multiedit', 'prompt'],
  codex: ['patch-add', 'patch-update', 'patch-delete', 'patch-move', 'bash-ignored', 'prompt'],
  cursor: ['write', 'shell-ignored', 'prompt'],
  gemini: ['write-file', 'replace', 'prompt'],
};

function substitute(value: unknown, root: string): unknown {
  if (typeof value === 'string') return value.replaceAll('__ROOT__', root);
  if (Array.isArray(value)) return value.map((v) => substitute(v, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, root)]));
  }
  return value;
}

function loadFixtures(id: HarnessId, root: string): Map<string, Fixture> {
  const dir = join(FIXTURES, id);
  const out = new Map<string, Fixture>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    out.set(name.replace(/\.json$/, ''), substitute(JSON.parse(readFileSync(join(dir, name), 'utf8')), root) as Fixture);
  }
  for (const required of REQUIRED[id] ?? []) assert.ok(out.has(required), `missing fixture ${id}/${required}.json`);
  return out;
}

const hookHarnesses = Object.keys(REQUIRED) as HarnessId[];

test('every hook harness has a fixture directory with its required cases', () => {
  for (const id of hookHarnesses) assert.ok(loadFixtures(id, '/r').size >= (REQUIRED[id]?.length ?? 0));
  for (const id of Object.keys(HARNESSES) as HarnessId[]) {
    assert.equal(HARNESSES[id].hooks === null, !hookHarnesses.includes(id), `${id} hook support and fixtures agree`);
  }
});

for (const id of hookHarnesses) {
  test(`${id}: fixtures parse to the expected writes and commands`, () => {
    const h = HARNESSES[id];
    for (const [name, fx] of loadFixtures(id, '/proj')) {
      const payload = h.hooks!.parse(fx.event, fx.stdin, {});
      assert.ok(payload, `${name} parses`);
      if (fx.expect.writes) {
        assert.deepEqual(extractWrites(h.writes, payload.toolName ?? '', payload.toolInput), fx.expect.writes, name);
      }
      if (fx.expect.command) {
        assert.deepEqual(parsePromptCommand(payload.prompt ?? '', isCommandName), fx.expect.command, name);
      }
    }
  });

  test(`${id}: a code write is denied at the trigger and passes otherwise`, async () => {
    const h = HARNESSES[id];
    for (const [name, fx] of loadFixtures(id, '__ROOT__')) {
      if (fx.event !== 'write') continue;
      const box = sandbox();
      const stdin = JSON.stringify(substitute(fx.stdin, box.root));
      const sm = openSpotMe(box.root, h.vocab, { env: box.env });
      assert.deepEqual(await runHook(id, 'write', stdin, box.env), h.hooks!.pass('write'), `${name} passes while off`);
      await sm.command('on', '--every 1');
      const reply = await runHook(id, 'write', stdin, box.env);
      const counts = (fx.expect.writes?.length ?? 0) > 0 && fx.expect.code !== false;
      if (counts) {
        assert.deepEqual(reply, h.hooks!.deny(extractReason(reply.stdout)), name);
        assert.match(reply.stdout, /Counter reached/, name);
        const step1 = fx.expect.writes![0]!.kind === 'create' ? new RegExp(`using the ${h.vocab.writeTool} tool`) : /1\. Edit `/;
        assert.match(reply.stdout, step1, `${name} gives the scaffold step for its write kind`);
      } else {
        assert.deepEqual(reply, h.hooks!.pass('write'), `${name} is not a counted write`);
      }
    }
  });
}

function extractReason(stdout: string): string {
  const o = JSON.parse(stdout) as Record<string, unknown>;
  const hso = o.hookSpecificOutput as Record<string, unknown> | undefined;
  return String(hso?.permissionDecisionReason ?? o.reason ?? o.user_message ?? '');
}

for (const id of ['claude', 'codex', 'cursor', 'gemini'] as const) {
  test(`${id}: state commands stop the prompt locally, prompt commands reach the model`, async () => {
    const h = HARNESSES[id];
    const box = sandbox();
    const prompt = loadFixtures(id, box.root).get('prompt')!;
    const status = await runHook(id, 'prompt', JSON.stringify(prompt.stdin), box.env);
    assert.deepEqual(status, h.hooks!.stop(extractReason(status.stdout)));
    assert.match(status.stdout, /SpotMe: .*off/);

    const asPrompt = (text: string) => JSON.stringify({ ...(prompt.stdin as object), prompt: text });
    await runHook(id, 'prompt', asPrompt(`${h.vocab.command('on')} hard --every 4`), box.env);
    assert.match(
      (await openSpotMe(box.root, h.vocab, { env: box.env }).callTool('spotme_status', {})).text,
      /Difficulty: hard\nTrigger every: 4/,
      'on ran exactly once, in the hook',
    );
    assert.deepEqual(await runHook(id, 'prompt', asPrompt(h.vocab.command('rep')), box.env), h.hooks!.pass('prompt'));
    assert.deepEqual(await runHook(id, 'prompt', asPrompt('please refactor src/a.ts'), box.env), h.hooks!.pass('prompt'));
    const refused = await runHook(id, 'prompt', asPrompt(h.vocab.command('done')), box.env);
    assert.match(refused.stdout, /No active SpotMe exercise to review/);
  });
}

test('an expanded command file is recognized by its sentinel line', () => {
  assert.deepEqual(parsePromptCommand(commandFileBody('on', 'hard --every 3'), isCommandName), { name: 'on', args: 'hard --every 3' });
  assert.deepEqual(parsePromptCommand(commandFileBody('status', null), isCommandName), { name: 'status', args: '' });
});

test('prompt command recognition is anchored to the first line', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['/spotme:on hard --every 3', { name: 'on', args: 'hard --every 3' }],
    ['  /spotme-skip\nmore text', { name: 'skip', args: '' }],
    ['spotme:Status', { name: 'status', args: '' }],
    ['/spotme:explode', null],
    ['please run /spotme:on', null],
    ['/spotmeon', null],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parsePromptCommand(input, isCommandName), expected, input);
});

test('patch headers: Add creates, Update edits, Delete is ignored, Move retargets', () => {
  const patch = ['*** Begin Patch', '*** Add File: a.ts', '+x', '*** Delete File: gone.ts', '*** Update File: b.ts', '*** Move to: c.ts', '*** End Patch'].join('\n');
  assert.deepEqual(parsePatch(patch), [
    { kind: 'create', path: 'a.ts' },
    { kind: 'edit', path: 'c.ts' },
  ]);
});

test('tool names match case-insensitively and the matcher covers the write table', () => {
  assert.deepEqual(extractWrites(HARNESSES.droid.writes, 'create', { file_path: 'a.ts' }), [{ kind: 'create', path: 'a.ts' }]);
  const re = new RegExp(writeMatcher(HARNESSES.gemini.writes));
  assert.ok(re.test('write_file') && re.test('replace') && !re.test('read_file'));
});

test('malformed hook input passes without throwing', async () => {
  const box = sandbox();
  for (const stdin of ['', 'not json', '[]', '{"tool_name": 5}']) {
    assert.deepEqual(await runHook('droid', 'write', stdin, box.env), { stdout: '', exitCode: 0 }, stdin);
  }
  assert.deepEqual(await runHook('pi', 'write', '{}', box.env), { stdout: '', exitCode: 0 });
});
