import { join } from 'node:path';
import { COMMAND_NAMES } from './engine.ts';
import type { CommandName } from './engine.ts';
import { COMMAND_SPECS, commandFileBody } from './messages.ts';
import type { Vocab } from './messages.ts';
import {
  claudeFamily,
  field,
  file,
  hookCommand,
  hooksJson,
  mcpArgv,
  mcpServersJson,
  namedEntryJson,
  namedHookJson,
  note,
  parseCommonPayload,
  pathField,
  patchField,
  scopeBase,
  skillFile,
  writeMatcher,
} from './harness.ts';
import type { Asset, Harness, HookProtocol, JsonObject, WriteTable } from './harness.ts';

const colon = (n: CommandName) => `/spotme:${n}`;

function markdownCommand(name: CommandName, argsToken: string | null): string {
  const spec = COMMAND_SPECS[name];
  const hint = spec.argHint ? `argument-hint: ${JSON.stringify(spec.argHint)}\n` : '';
  return `---\ndescription: ${JSON.stringify(spec.summary)}\n${hint}---\n${commandFileBody(name, argsToken)}`;
}

const commandFiles = (dir: string, fileName: (n: CommandName) => string, argsToken: string | null): Asset[] =>
  COMMAND_NAMES.map((n) => file(join(dir, fileName(n)), markdownCommand(n, argsToken)));

// Droid. Create and Edit payloads MEASURED; ApplyPatch from docs. UserPromptSubmit did not fire
// under `droid exec`, so commands are Markdown files that route through spotme_command.
const droidWrites: WriteTable = {
  Create: pathField('file_path', 'create'),
  Edit: pathField('file_path', 'edit'),
  ApplyPatch: patchField('input'),
};
const droid: Harness = {
  vocab: { command: colon, writeTool: 'Create', editTool: 'Edit' },
  writes: droidWrites,
  hooks: claudeFamily({ prompt: null, dirEnv: 'FACTORY_PROJECT_DIR' }),
  scopes: ['project', 'user'],
  binary: 'droid',
  assets: (ctx) => {
    const dir = scopeBase(ctx, '.factory');
    return [
      hooksJson(join(dir, 'hooks.json'), 'bare', [
        { event: 'PreToolUse', matcher: writeMatcher(droidWrites), command: hookCommand(ctx, 'write') },
      ]),
      ...commandFiles(join(dir, 'commands', 'spotme'), (n) => `${n}.md`, '$ARGUMENTS'),
      skillFile(join(dir, 'skills', 'spotme', 'SKILL.md'), droid.vocab),
      mcpServersJson(join(dir, 'mcp.json'), ctx, { type: 'stdio' }),
    ];
  },
};

// Claude Code (docs only, untested). `/spotme:on` needs a plugin named spotme, so install
// generates one local plugin and enables it through settings.
const claudeWrites: WriteTable = {
  Write: pathField('file_path', 'create'),
  Edit: pathField('file_path', 'edit'),
  MultiEdit: pathField('file_path', 'edit'),
};
const claude: Harness = {
  vocab: { command: colon, writeTool: 'Write', editTool: 'Edit' },
  writes: claudeWrites,
  hooks: claudeFamily({ prompt: 'UserPromptSubmit', dirEnv: 'CLAUDE_PROJECT_DIR' }),
  scopes: ['project', 'user'],
  binary: 'claude',
  assets: (ctx) => {
    const plugin = ctx.scope === 'project' ? join(ctx.project, '.claude', 'spotme-plugin') : join(ctx.dataDir, 'claude-plugin');
    const settings =
      ctx.scope === 'project' ? join(ctx.project, '.claude', 'settings.local.json') : join(ctx.home, '.claude', 'settings.json');
    return [
      file(join(plugin, '.claude-plugin', 'marketplace.json'), {
        name: 'spotme-local',
        owner: { name: 'spotme' },
        plugins: [{ name: 'spotme', source: './', description: 'Gym mode for agentic coding' }],
      }),
      file(join(plugin, '.claude-plugin', 'plugin.json'), {
        name: 'spotme',
        version: ctx.version,
        description: 'Gym mode for agentic coding',
      }),
      file(join(plugin, 'hooks', 'hooks.json'), {
        hooks: {
          PreToolUse: [{ matcher: writeMatcher(claudeWrites), hooks: [{ type: 'command', command: hookCommand(ctx, 'write') }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand(ctx, 'prompt') }] }],
        },
      }),
      ...commandFiles(join(plugin, 'commands'), (n) => `${n}.md`, '$ARGUMENTS'),
      skillFile(join(plugin, 'skills', 'spotme', 'SKILL.md'), claude.vocab),
      mcpServersJson(join(plugin, '.mcp.json'), ctx),
      {
        kind: 'json',
        path: settings,
        edit: (doc, op) => {
          const next: JsonObject = structuredClone(doc);
          const markets = namedEntryJson(settings, 'extraKnownMarketplaces', 'spotme-local', {
            source: { source: 'directory', path: plugin },
          });
          const enabled = namedEntryJson(settings, 'enabledPlugins', 'spotme@spotme-local', true);
          const apply = (a: Asset, d: JsonObject) => (a.kind === 'json' ? a.edit(d, op) : d);
          return apply(enabled, apply(markets, next));
        },
      },
      note(
        `Claude Code support is untested. If /spotme:on is missing after restarting Claude, run:\n  /plugin marketplace add ${plugin}\n  /plugin install spotme@spotme-local`,
      ),
    ];
  },
};

// Codex CLI. apply_patch payload and UserPromptSubmit blocking MEASURED under `codex exec`.
// Custom prompts are deprecated, so there are no command files: the prompt hook sees the raw
// `/spotme:<name>` text and the skill sends prompt commands to spotme_command.
const codexWrites: WriteTable = { apply_patch: patchField('command') };
const codex: Harness = {
  vocab: { command: colon, writeTool: 'apply_patch', editTool: 'apply_patch' },
  writes: codexWrites,
  hooks: claudeFamily({ prompt: 'UserPromptSubmit', dirEnv: null }),
  scopes: ['project', 'user'],
  binary: 'codex',
  assets: (ctx) => {
    const dir = scopeBase(ctx, '.codex');
    const [command, ...args] = mcpArgv(ctx);
    return [
      hooksJson(join(dir, 'hooks.json'), 'wrapped', [
        { event: 'PreToolUse', matcher: writeMatcher(codexWrites), command: hookCommand(ctx, 'write') },
        { event: 'UserPromptSubmit', command: hookCommand(ctx, 'prompt') },
      ]),
      {
        kind: 'tomlBlock',
        path: join(dir, 'config.toml'),
        body: `[mcp_servers.spotme]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ndefault_tools_approval_mode = "approve"\n`,
      },
      skillFile(join(scopeBase(ctx, '.agents'), 'skills', 'spotme', 'SKILL.md'), codex.vocab),
      note('Codex asks you to review new hooks on next launch. `codex exec` needs --dangerously-bypass-hook-trust.'),
    ];
  },
};

// Cursor agent CLI. preToolUse payload and deny shape MEASURED in `cursor-agent -p`;
// beforeSubmitPrompt did not fire in print mode (docs say it fires in interactive chat).
const cursorProtocol: HookProtocol = {
  events: { write: 'preToolUse', prompt: 'beforeSubmitPrompt' },
  parse: (_event, stdin, env) => {
    const base = parseCommonPayload(stdin, env, null);
    const roots = field(stdin, 'workspace_roots');
    const first = Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] ? roots[0] : undefined;
    return { ...base, dir: first ?? base.dir };
  },
  deny: (r) => ({ stdout: JSON.stringify({ permission: 'deny', user_message: r, agent_message: r }), exitCode: 0 }),
  pass: (e) => ({ stdout: e === 'write' ? '' : JSON.stringify({ continue: true }), exitCode: 0 }),
  stop: (t) => ({ stdout: JSON.stringify({ continue: false, user_message: t }), exitCode: 0 }),
};
const cursorWrites: WriteTable = { Write: pathField('file_path', 'create') };
const cursor: Harness = {
  vocab: { command: (n) => `/spotme-${n}`, writeTool: 'Write', editTool: 'Write' },
  writes: cursorWrites,
  hooks: cursorProtocol,
  scopes: ['project', 'user'],
  binary: 'cursor-agent',
  assets: (ctx) => {
    const dir = scopeBase(ctx, '.cursor');
    return [
      hooksJson(join(dir, 'hooks.json'), 'cursor-v1', [
        { event: 'preToolUse', matcher: writeMatcher(cursorWrites), command: hookCommand(ctx, 'write') },
        { event: 'beforeSubmitPrompt', command: hookCommand(ctx, 'prompt') },
      ]),
      ...commandFiles(join(dir, 'commands'), (n) => `spotme-${n}.md`, null),
      skillFile(join(dir, 'skills', 'spotme', 'SKILL.md'), cursor.vocab),
      mcpServersJson(join(dir, 'mcp.json'), ctx, { type: 'stdio' }),
    ];
  },
};

// Gemini CLI (docs only, untested).
const geminiProtocol: HookProtocol = {
  events: { write: 'BeforeTool', prompt: 'BeforeAgent' },
  parse: (_event, stdin, env) => parseCommonPayload(stdin, env, 'GEMINI_PROJECT_DIR'),
  deny: (r) => ({ stdout: JSON.stringify({ decision: 'deny', reason: r }), exitCode: 0 }),
  pass: () => ({ stdout: '', exitCode: 0 }),
  stop: (t) => ({ stdout: JSON.stringify({ decision: 'deny', reason: t }), exitCode: 0 }),
};
const geminiWrites: WriteTable = { write_file: pathField('file_path', 'create'), replace: pathField('file_path', 'edit') };
const gemini: Harness = {
  vocab: { command: colon, writeTool: 'write_file', editTool: 'replace' },
  writes: geminiWrites,
  hooks: geminiProtocol,
  scopes: ['project', 'user'],
  binary: 'gemini',
  assets: (ctx) => {
    const dir = scopeBase(ctx, '.gemini');
    return [
      hooksJson(
        join(dir, 'settings.json'),
        'wrapped',
        [
          { event: 'BeforeTool', matcher: writeMatcher(geminiWrites), command: hookCommand(ctx, 'write') },
          { event: 'BeforeAgent', command: hookCommand(ctx, 'prompt') },
        ],
        { timeoutMs: 10_000 },
      ),
      mcpServersJson(join(dir, 'settings.json'), ctx),
      ...COMMAND_NAMES.map((n) =>
        file(
          join(dir, 'commands', 'spotme', `${n}.toml`),
          `description = ${JSON.stringify(COMMAND_SPECS[n].summary)}\nprompt = ${JSON.stringify(commandFileBody(n, '{{args}}'))}\n`,
        ),
      ),
    ];
  },
};

// Antigravity CLI. write_file, edit_file and all hook replies MEASURED on 1.5.1.
// PreInvocation fires before every model call, so only the first invocation may run a command.
// Empty stdout passes: {} denies, while an explicit allow auto-approves the tool call.
const antigravityProtocol: HookProtocol = {
  events: { write: 'PreToolUse', prompt: 'PreInvocation' },
  parse: (_event, stdin) => {
    const roots = field(stdin, 'workspacePaths');
    const dir = Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] ? roots[0] : undefined;
    const toolCall = field(stdin, 'toolCall');
    const toolName = field(toolCall, 'name');
    const invocation = field(stdin, 'invocationNum');
    const prompt = field(stdin, 'lastUserInput');
    return {
      dir,
      toolName: typeof toolName === 'string' && toolName ? toolName : undefined,
      toolInput: field(toolCall, 'args'),
      prompt: (invocation === undefined || invocation === 0) && typeof prompt === 'string' && prompt ? prompt : undefined,
    };
  },
  deny: (r) => ({ stdout: JSON.stringify({ decision: 'deny', reason: r }), exitCode: 0 }),
  pass: () => ({ stdout: '', exitCode: 0 }),
  stop: (t) => ({
    stdout: JSON.stringify({ injectSteps: [{ errorMessage: { userMessage: t } }], terminationBehavior: 'terminate' }),
    exitCode: 0,
  }),
};
const antigravityWrites: WriteTable = {
  write_file: pathField('Path', 'create'),
  edit_file: pathField('Path', 'edit'),
  // DOC only. Antigravity 1.5.1 emitted the measured names above instead.
  write_to_file: pathField('TargetFile', 'create'),
  replace_file_content: pathField('TargetFile', 'edit'),
  multi_replace_file_content: pathField('TargetFile', 'edit'),
};
const antigravity: Harness = {
  vocab: { command: (n) => `/spotme-${n}`, writeTool: 'write_file', editTool: 'edit_file' },
  writes: antigravityWrites,
  hooks: antigravityProtocol,
  scopes: ['project', 'user'],
  binary: 'agy',
  assets: (ctx) => {
    const dir = ctx.scope === 'project' ? join(ctx.project, '.agents') : join(ctx.home, '.gemini', 'config');
    return [
      namedHookJson(join(dir, 'hooks.json'), 'spotme', {
        PreToolUse: [
          {
            matcher: writeMatcher(antigravityWrites),
            hooks: [{ type: 'command', command: hookCommand(ctx, 'write'), timeout: 10 }],
          },
        ],
        PreInvocation: [{ type: 'command', command: hookCommand(ctx, 'prompt'), timeout: 10 }],
      }),
      ...COMMAND_NAMES.map((n) =>
        file(
          join(dir, 'skills', `spotme-${n}`, 'SKILL.md'),
          `---\nname: spotme-${n}\ndescription: ${JSON.stringify(`${COMMAND_SPECS[n].summary}. Use only when the user runs /spotme-${n}.`)}\n---\n\n${commandFileBody(n, null)}`,
        ),
      ),
      skillFile(join(dir, 'skills', 'spotme-antigravity', 'SKILL.md'), antigravity.vocab, 'spotme-antigravity'),
      mcpServersJson(join(dir, 'mcp_config.json'), ctx),
    ];
  },
};

// OpenCode 2.x. Tool names and arg keys read from the installed 2.0.12 binary: write {path, content},
// edit {path, oldString, newString}, patch {patchText}. 2.0.12 rejects a plugin configured as an
// absolute file path but loads any .js file in a plugins/ config directory, so install writes a
// small shim there that imports the stable runtime copy with this project's options baked in.
const opencode: Harness = {
  vocab: { command: colon, writeTool: 'write', editTool: 'edit' },
  writes: { write: pathField('path', 'create'), edit: pathField('path', 'edit'), patch: patchField('patchText') },
  hooks: null,
  scopes: ['project', 'user'],
  binary: 'opencode',
  assets: (ctx) => {
    const config = ctx.scope === 'project' ? join(ctx.project, 'opencode.json') : join(ctx.home, '.config', 'opencode', 'opencode.json');
    const commands = ctx.scope === 'project' ? join(ctx.project, '.opencode', 'commands') : join(ctx.home, '.config', 'opencode', 'commands');
    const configDir = ctx.scope === 'project' ? join(ctx.project, '.opencode') : join(ctx.home, '.config', 'opencode');
    const runtime = join(ctx.dataDir, 'runtime', 'opencode.js');
    const options = { ...(ctx.scope === 'project' ? { root: ctx.project } : {}), ...(ctx.stateDir ? { stateDir: ctx.stateDir } : {}) };
    const [command, ...args] = mcpArgv(ctx);
    return [
      namedEntryJson(config, 'mcp', 'spotme', { type: 'local', command: [command!, ...args], enabled: true }),
      file(
        join(configDir, 'plugins', 'spotme.js'),
        `import { spotmePlugin } from ${JSON.stringify(runtime)};\n\nexport default spotmePlugin(${JSON.stringify(options)});\n`,
      ),
      ...commandFiles(commands, (n) => `spotme:${n}.md`, '$ARGUMENTS'),
    ];
  },
};

// Pi (in-process extension). The 0.84.2 SDK ships only `write` and `edit` file tools, both keyed by `path`.
const pi: Harness = {
  vocab: { command: colon, writeTool: 'write', editTool: 'edit' },
  writes: { write: pathField('path', 'create'), edit: pathField('path', 'edit') },
  hooks: null,
  scopes: ['user'],
  binary: 'pi',
  assets: () => [note('Pi loads SpotMe as a package: run `pi install npm:agnostic-spotme` (or `pi install <path to this package>`).')],
};

export const HARNESSES = { droid, claude, codex, cursor, gemini, antigravity, opencode, pi } as const satisfies Record<string, Harness>;
export type HarnessId = keyof typeof HARNESSES;
export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

export const GENERIC_VOCAB: Vocab = { command: colon, writeTool: 'Write', editTool: 'Edit' };

export function isHarnessId(s: unknown): s is HarnessId {
  return typeof s === 'string' && s in HARNESSES;
}

