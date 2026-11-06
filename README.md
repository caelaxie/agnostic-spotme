# SpotMe for any coding agent

SpotMe is gym mode for agentic coding. While it is on, every Nth code-file write the agent makes is stopped. The agent then scaffolds one unit of work in that file (signature, types, a `SPOTME:` marker comment where your code goes), registers it as an exercise, and hands the keyboard to you. You implement it and close the loop with `done`, `hint`, `solve` or `skip`.

This package runs the same state machine in eight harnesses:

| Harness | How SpotMe plugs in | Commands |
|---------|---------------------|----------|
| Droid | `PreToolUse` hook, MCP server, Markdown commands, skill | `/spotme:on` ... |
| Claude Code | generated local plugin (hooks, commands, skill, MCP) | `/spotme:on` ... |
| Codex CLI | `PreToolUse` and `UserPromptSubmit` hooks, MCP server, skill | type `/spotme:on` ... as a prompt |
| Cursor | `preToolUse` and `beforeSubmitPrompt` hooks, MCP server, commands, skill | `/spotme-on` ... |
| Gemini CLI | `BeforeTool` and `BeforeAgent` hooks, MCP server, TOML commands | `/spotme:on` ... |
| Antigravity CLI | `PreToolUse` and `PreInvocation` hooks, MCP server, command skills, main skill | `/spotme-on` ... |
| OpenCode 2.x | in-process plugin, MCP server, commands | `/spotme:on` ... |
| Pi | in-process extension | `/spotme:on` ... |

## Install

Requires Node 20 or newer.

```sh
npx agnostic-spotme install droid          # project scope, the default
npx agnostic-spotme install codex --user   # every project for this user
npx agnostic-spotme install all            # every harness this package knows
npx agnostic-spotme install cursor --dry-run
```

`install` copies the built CLI to `${XDG_DATA_HOME:-~/.local/share}/spotme/runtime/` and points every hook and MCP entry at that copy through the absolute path of the `node` that ran the installer. Nothing calls `npx` at hook time, so a hook costs one Node start. Project installs bake `--root <project>` into each command, so the hooks do not depend on the harness reporting the right directory.

Running `install` again is safe. It rewrites only what changed and leaves your own entries in shared files (`hooks.json`, `mcp.json`, `mcp_config.json`, `settings.json`, `config.toml`, `opencode.json`) alone. `uninstall` removes exactly what `install` added.

```sh
npx agnostic-spotme doctor    # runtime present, per-harness scope, stale or doubled installs
npx agnostic-spotme uninstall droid
```

Install one scope per harness. If a harness has SpotMe at both project and user scope, every write is counted twice; `install` and `doctor` warn about it.

Harness notes:

- Codex asks you to trust new hooks on the next launch. `codex exec` needs `--dangerously-bypass-hook-trust`.
- Claude Code: if `/spotme:on` is missing after a restart, run `/plugin marketplace add <project>/.claude/spotme-plugin` then `/plugin install spotme@spotme-local`.
- Pi: `pi install npm:agnostic-spotme`, or `pi -e <this package>/src/pi.ts` for one run.
- OpenCode: install writes `.opencode/plugins/spotme.js`, a two-line shim that imports the runtime copy, because OpenCode 2.0.12 rejects a plugin configured as an absolute file path.

## Commands

| Command | Effect |
|---------|--------|
| `on [lite\|medium\|hard] [--every N]` | Turn gym mode on (default `medium`, every 2 code writes). Always restarts the count. |
| `off` | Turn it off. Settings are kept. |
| `status` | Mode, count, pending scaffold, active exercise. |
| `done` | Ask the agent to review your implementation. |
| `hint` | Ask for a hint without the answer. |
| `solve` | Let the agent finish the unit. |
| `skip` | Drop the exercise, or cancel a pending scaffold. |
| `rep` | Ask for an exercise now, outside the counter. |

The same verbs work from a terminal, which is handy where a harness has no prompt hook:

```sh
npx agnostic-spotme on hard --every 3
npx agnostic-spotme status
```

## How it works

`src/engine.ts` is a pure state machine: `Off`, `Idle(count)`, `AwaitingScaffold`, `Active(exercise)`. The adapters translate harness events into engine inputs and render the result in each harness's own format. State lives in one JSON file per project, keyed by the sha256 of the project's canonical git root, under `${XDG_STATE_HOME:-~/.local/state}/spotme/` (`%LOCALAPPDATA%\spotme` on Windows, override with `SPOTME_STATE_DIR`). Concurrent hook processes serialize on a lock file. See [docs/flow.md](docs/flow.md) for the transition diagram and rules.

The model talks to SpotMe through three MCP tools (`spotme_exercise`, `spotme_status`, `spotme_end`) plus `spotme_command`, which is how commands reach the engine in harnesses whose commands are prompt templates. OpenCode and Pi run the engine in process.

## Verification

`npm test` runs the unit and integration suite: the engine, the store under concurrent writers, every harness's hook payloads and replies against recorded fixtures, the MCP server over stdio, install and uninstall idempotency, and the CLI end to end. `npm run smoke -- <harness...>` drives a real agent through one denial and one registered exercise in a temporary git repository. `scripts/loop.sh droid|codex|antigravity` runs the whole cycle (on, status, a code write, a scripted stand-in for your implementation, done, off) against a live agent and checks the saved mode after each step.

Live status:

| Harness | Status | Evidence |
|---------|--------|----------|
| Droid 1.4.1 | live smoke passes | `droid exec --auto high`: one denial, scaffold with marker, exercise registered over MCP |
| Codex CLI 0.166.0 | live smoke passes | `codex exec`: one `apply_patch` denial, scaffold, exercise registered over MCP |
| Cursor agent | live smoke passes | `cursor-agent -p`: one `Write` denial, scaffold, exercise registered over MCP |
| Antigravity CLI 1.5.2 | live smoke and full loop pass | `agy -p`: one `write_file` denial, scaffold, exercise registered over MCP, then `done` and `off` checked through saved state. The interactive TUI was driven by hand for on, a write, status and off |
| Pi 0.84.2 | live smoke passes | `pi -p -e src/pi.ts`: exercise registered through the in-process tool |
| OpenCode 2.0.12 | loading verified, write denial not run live | plugin listed active, MCP server connected, all eight commands registered; no model provider was available for a full run |
| Claude Code | untested | built from published hook and plugin docs; payloads in `test/fixtures/claude` are doc-shaped |
| Gemini CLI | untested | built from published hook docs; payloads in `test/fixtures/gemini` are doc-shaped |

`droid exec` needs `--auto high` to call the MCP tools without a prompt. Interactive Droid sessions were not exercised.

## Limitations

- Writes made through a shell command (`echo > file`, `sed -i`) are not counted. Only the harness's file-writing tools are.
- A code file is one of the extensions in `CODE_EXTENSIONS` in `src/engine.ts`. Markdown, JSON and config files never count.
- In Droid, `on`, `off` and `status` go through the model (the command file asks it to call `spotme_command` and relay the reply), because the prompt hook did not fire under `droid exec`. That costs one model turn.
- Cursor's `beforeSubmitPrompt` hook did not fire in `cursor-agent -p`; there the command files route through the model instead.
- Antigravity renders handled `on`, `off` and `status` replies as a `⚠` warning line. In print mode, `agy -p` prints `error: <text>` and exits 3 even though the hook handled the command.
- Antigravity 1.5.1 and 1.5.2 emit `write_file` and `edit_file` with `Path`. The website instead documents `write_to_file`, `replace_file_content` and `multi_replace_file_content` with `TargetFile`. SpotMe accepts both sets.
- When Codex and Antigravity are both installed in one project, each also reads the other's skills under `.agents/skills`.
- The OpenCode 2.x plugin API was read from the installed 2.0.12 binary, not from published documentation, and may change.
- If the state lock cannot be taken within about two seconds, the write is let through rather than blocking the agent.

## License

None yet. Upstream [wtfzambo/spotme](https://github.com/wtfzambo/spotme) publishes no license, and this package ports its prompt text, so a license has to be agreed with the upstream author first.
