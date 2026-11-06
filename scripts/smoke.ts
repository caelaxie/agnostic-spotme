import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { canonicalRoot, openStore } from '../src/store.ts';

const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'dist', 'cli.mjs');

const PROMPT =
  'Create the file src/greet.ts exporting a function greet(name: string): string that returns `Hello, ${name}!`. ' +
  'Write files with your file editing tool, never with the shell. ' +
  'If a tool call is denied or a hook or tool result gives you instructions, follow those instructions exactly, then stop.';

interface Run {
  readonly argv: readonly string[];
  readonly install: boolean;
  readonly env?: Record<string, string>;
}

const RUNS: Record<string, (project: string) => Run> = {
  droid: () => ({ argv: ['droid', 'exec', '--auto', 'high', PROMPT], install: true }),
  codex: (p) => ({
    argv: ['codex', 'exec', '-C', p, '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', PROMPT],
    install: true,
  }),
  cursor: (p) => ({ argv: ['cursor-agent', '-p', '--force', '--trust', '--approve-mcps', '--workspace', p, PROMPT], install: true }),
  antigravity: () => ({
    argv: ['agy', '-p', PROMPT, '--dangerously-skip-permissions', '--print-timeout', '300s'],
    install: true,
  }),
  pi: () => ({
    argv: ['pi', '-p', '--no-session', '--approve', '--provider', 'openai-codex', '--model', 'gpt-5.6-terra', '-e', join(REPO, 'src', 'pi.ts'), PROMPT],
    install: false,
  }),
};

function codeFilesWithMarker(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p, 'utf8').includes('SPOTME:')) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

function run(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, log: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(log, out);
      resolve(code);
    });
  });
}

async function smoke(harness: string): Promise<Record<string, unknown>> {
  const base = mkdtempSync(join(tmpdir(), `spotme-smoke-${harness}-`));
  const project = join(base, 'project');
  const state = join(base, 'state');
  const capture = join(base, 'capture');
  mkdirSync(project, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: project });
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: join(base, 'data'), SPOTME_CAPTURE_DIR: capture, SPOTME_STATE_DIR: state };
  const spec = RUNS[harness]!(project);
  if (spec.install) {
    const r = spawnSync(process.execPath, [CLI, 'install', harness, '--root', project, '--state-dir', state], { env, encoding: 'utf8' });
    writeFileSync(join(base, 'install.log'), r.stdout + r.stderr);
    if (r.status !== 0) return { harness, ok: false, base, error: 'install failed' };
  }
  spawnSync(process.execPath, [CLI, 'on', '--every', '1', '--root', project, '--state-dir', state], { env });
  const started = Date.now();
  const code = await run(spec.argv, project, env, join(base, 'agent.log'), 8 * 60_000);
  const hooks = existsSync(join(capture, 'hooks.jsonl'))
    ? readFileSync(join(capture, 'hooks.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { event: string; stdout: string; stdin: { tool_name?: string; toolCall?: { name?: string } } })
    : [];
  const denials = hooks.filter((h) => h.stdout.includes('Counter reached')).length;
  const mode = (await openStore(canonicalRoot(project), { dir: state }).read()).mode;
  const markers = codeFilesWithMarker(project);
  const ok = mode.kind === 'active' && markers.length > 0 && (spec.install ? denials === 1 : true);
  return {
    harness,
    ok,
    exitCode: code,
    seconds: Math.round((Date.now() - started) / 1000),
    hookFirings: hooks.length,
    hookTools: [...new Set(hooks.map((h) => h.stdin?.tool_name ?? h.stdin?.toolCall?.name ?? h.event))],
    denials,
    markers,
    mode,
    base,
  };
}

const only = process.argv.slice(2);
const targets = only.length > 0 ? only : Object.keys(RUNS);
if (!existsSync(CLI)) throw new Error('dist/cli.mjs is missing; run `npm run build`');
const results = await Promise.all(targets.map((h) => smoke(h).catch((e: unknown) => ({ harness: h, ok: false, error: String(e) }))));
for (const r of results) console.log(JSON.stringify(r));
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
