import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import type { Scope } from '../src/harness.ts';
import { HARNESSES, HARNESS_IDS } from '../src/harnesses.ts';
import type { HarnessId } from '../src/harnesses.ts';
import { apply, installCtx, plan, presence } from '../src/install.ts';
import { sandbox } from './helpers.ts';
import type { Sandbox } from './helpers.ts';

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const ctxOf = (box: Sandbox, id: HarnessId, scope: Scope, bin?: string) =>
  installCtx(id, { scope, project: box.root, env: box.env, version: '0.0.0-test', bin, stateDir: box.stateDir });

const assetsOf = (box: Sandbox, id: HarnessId, scope: Scope, bin?: string) => HARNESSES[id].assets(ctxOf(box, id, scope, bin));

for (const id of HARNESS_IDS) {
  for (const scope of HARNESSES[id].scopes) {
    test(`${id} ${scope}: install converges, and uninstall leaves only what was there`, async () => {
      const box = sandbox();
      const before = { project: files(box.root), home: files(box.home) };
      await apply(await plan(assetsOf(box, id, scope), 'install'));
      const again = await plan(assetsOf(box, id, scope), 'install');
      assert.deepEqual(again.changes.filter((c) => c.action !== 'unchanged'), [], 'a second install changes nothing');
      const expected = HARNESSES[id].assets(ctxOf(box, id, scope)).every((a) => a.kind === 'note') ? 'external' : 'installed';
      assert.equal(await presence(ctxOf(box, id, scope)), expected);

      await apply(await plan(assetsOf(box, id, scope), 'uninstall'));
      assert.deepEqual({ project: files(box.root), home: files(box.home) }, before);
      const twice = await plan(assetsOf(box, id, scope), 'uninstall');
      assert.ok(twice.changes.every((c) => c.action === 'absent'), 'a second uninstall changes nothing');
    });
  }
}

test('hook and MCP launchers bake the project root and state dir for project scope', async () => {
  const box = sandbox();
  await apply(await plan(assetsOf(box, 'droid', 'project'), 'install'));
  const hooks = JSON.parse(readFileSync(join(box.root, '.factory', 'hooks.json'), 'utf8'));
  const command: string = hooks.PreToolUse[0].hooks[0].command;
  assert.ok(command.startsWith(process.execPath), 'launches the current node, not npx');
  assert.match(command, new RegExp(`hook droid write --root ${box.root} --state-dir ${box.stateDir}$`));
  const mcp = JSON.parse(readFileSync(join(box.root, '.factory', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.spotme.args.slice(1), ['mcp', '--harness', 'droid', '--root', box.root, '--state-dir', box.stateDir]);
});

test('user scope does not bake a root', async () => {
  const box = sandbox();
  const ctx = ctxOf(box, 'codex', 'user');
  assert.deepEqual(ctx.baked, ['--state-dir', box.stateDir]);
});

test('user hooks, settings and TOML survive an install and uninstall byte for byte', async () => {
  const box = sandbox();
  const userHooks = `${JSON.stringify({ PreToolUse: [{ matcher: 'Execute', hooks: [{ type: 'command', command: 'audit.sh' }] }] }, null, 2)}\n`;
  const userToml = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
  const userGemini = `${JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2)}\n`;
  seed(join(box.root, '.factory', 'hooks.json'), userHooks);
  seed(join(box.root, '.codex', 'config.toml'), userToml);
  seed(join(box.root, '.gemini', 'settings.json'), userGemini);
  for (const id of ['droid', 'codex', 'gemini'] as const) await apply(await plan(assetsOf(box, id, 'project'), 'install'));

  const merged = JSON.parse(readFileSync(join(box.root, '.factory', 'hooks.json'), 'utf8'));
  assert.equal(merged.PreToolUse.length, 2, 'the user hook is kept next to ours');
  const toml = readFileSync(join(box.root, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^model = "gpt-5"[\s\S]*# >>> spotme >>>\n\[mcp_servers\.spotme\]\n[\s\S]*# <<< spotme <<<\n$/);
  const gemini = JSON.parse(readFileSync(join(box.root, '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(gemini.mcpServers).sort(), ['other', 'spotme']);
  assert.equal(gemini.hooks.BeforeTool[0].hooks[0].timeout, 10000);

  for (const id of ['droid', 'codex', 'gemini'] as const) await apply(await plan(assetsOf(box, id, 'project'), 'uninstall'));
  assert.equal(readFileSync(join(box.root, '.factory', 'hooks.json'), 'utf8'), userHooks);
  assert.equal(readFileSync(join(box.root, '.codex', 'config.toml'), 'utf8'), userToml);
  assert.equal(readFileSync(join(box.root, '.gemini', 'settings.json'), 'utf8'), userGemini);
});

test('Antigravity owns its named hook and leaves foreign named hooks untouched', async () => {
  const box = sandbox();
  const path = join(box.root, '.agents', 'hooks.json');
  const foreign = { herdr: { PreToolUse: [{ hooks: [{ type: 'command', command: 'herdr-hook' }] }] } };
  const before = `${JSON.stringify(foreign, null, 2)}\n`;
  seed(path, before);

  await apply(await plan(assetsOf(box, 'antigravity', 'project'), 'install'));
  const installed = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(installed.herdr, foreign.herdr);
  assert.equal(installed.spotme.PreToolUse[0].hooks[0].timeout, 10);
  assert.equal(installed.spotme.PreInvocation[0].timeout, 10);
  const command = readFileSync(join(box.root, '.agents', 'skills', 'spotme-on', 'SKILL.md'), 'utf8');
  assert.match(command, /^---\nname: spotme-on\n/);
  assert.match(command, /Use only when the user runs \/spotme-on\./);
  const skill = readFileSync(join(box.root, '.agents', 'skills', 'spotme-antigravity', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: spotme-antigravity\n/);
  const mcp = JSON.parse(readFileSync(join(box.root, '.agents', 'mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.spotme.type, undefined);

  await apply(await plan(assetsOf(box, 'antigravity', 'project'), 'uninstall'));
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a reinstall with a different launcher replaces the old hook instead of adding one', async () => {
  const box = sandbox();
  await apply(await plan(assetsOf(box, 'cursor', 'project', '/old/spotme'), 'install'));
  assert.equal(await presence(ctxOf(box, 'cursor', 'project')), 'outdated');
  await apply(await plan(assetsOf(box, 'cursor', 'project'), 'install'));
  const hooks = JSON.parse(readFileSync(join(box.root, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(hooks.version, 1);
  assert.equal(hooks.hooks.preToolUse.length, 1);
  assert.ok(hooks.hooks.preToolUse[0].command.startsWith(process.execPath));
});

test('invalid JSON is refused and left untouched', async () => {
  const box = sandbox();
  const path = join(box.root, '.cursor', 'hooks.json');
  seed(path, '{ "version": 1, // comment\n}');
  const p = await plan(assetsOf(box, 'cursor', 'project'), 'install');
  assert.match(p.errors.join('\n'), /hooks\.json is not valid JSON/);
  await assert.rejects(apply(p));
  assert.equal(readFileSync(path, 'utf8'), '{ "version": 1, // comment\n}');
  assert.equal(files(box.root).length, 1, 'nothing else was written either');
});

test('a hand-written [mcp_servers.spotme] table is refused rather than duplicated', async () => {
  const box = sandbox();
  seed(join(box.root, '.codex', 'config.toml'), '[mcp_servers.spotme]\ncommand = "spotme"\n');
  const p = await plan(assetsOf(box, 'codex', 'project'), 'install');
  assert.match(p.errors.join('\n'), /already defines \[mcp_servers\.spotme\]/);
});

test('the OpenCode plugin shim imports the stable runtime with baked options', async () => {
  const box = sandbox();
  await apply(await plan(assetsOf(box, 'opencode', 'project'), 'install'));
  const shim = readFileSync(join(box.root, '.opencode', 'plugins', 'spotme.js'), 'utf8');
  assert.match(shim, /import \{ spotmePlugin \} from ".*\/spotme\/runtime\/opencode\.js";/);
  assert.match(shim, new RegExp(`spotmePlugin\\(\\{"root":"${box.root}","stateDir":"${box.stateDir}"\\}\\)`));
  const config = JSON.parse(readFileSync(join(box.root, 'opencode.json'), 'utf8'));
  assert.equal(config.mcp.spotme.type, 'local');
  assert.deepEqual(readdirSync(join(box.root, '.opencode', 'commands')).sort()[0], 'spotme:done.md');
});

test('Claude gets a local plugin enabled through settings', async () => {
  const box = sandbox();
  const p = await plan(assetsOf(box, 'claude', 'project'), 'install');
  assert.match(p.notes.join('\n'), /\/plugin marketplace add/);
  await apply(p);
  const settings = JSON.parse(readFileSync(join(box.root, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.enabledPlugins['spotme@spotme-local'], true);
  assert.equal(settings.extraKnownMarketplaces['spotme-local'].source.path, join(box.root, '.claude', 'spotme-plugin'));
  assert.ok(files(join(box.root, '.claude', 'spotme-plugin')).includes('commands/on.md'));
});
