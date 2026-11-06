import { extensionOf } from './engine.ts';
import type {
  CommandName,
  CommandOutcome,
  Difficulty,
  Exercise,
  ProjectRoot,
  RegisterRefusal,
  State,
  WriteOutcome,
} from './engine.ts';

export interface Vocab {
  readonly command: (name: CommandName) => string;
  readonly writeTool: string;
  readonly editTool: string;
}

export const COMMAND_SPECS: Readonly<Record<CommandName, { readonly summary: string; readonly argHint?: string }>> = {
  on: { summary: 'Enable SpotMe gym mode', argHint: '[lite|medium|hard] [--every N]' },
  off: { summary: 'Disable SpotMe gym mode' },
  status: { summary: 'Show current SpotMe status' },
  done: { summary: 'Submit your implementation for SpotMe review' },
  hint: { summary: 'Get a hint for the current exercise' },
  solve: { summary: 'Concede and let the agent finish the exercise' },
  skip: { summary: 'Skip this exercise' },
  rep: { summary: 'Request an on-demand SpotMe exercise' },
};

function difficultyLabel(d: Difficulty): string {
  switch (d) {
    case 'lite':
      return 'signature + structure provided — implement the body';
    case 'medium':
      return 'signature provided — implement the logic';
    case 'hard':
      return 'spec only — design and implement from scratch';
  }
}

const EXT_COMMENT: Readonly<Record<string, { open: string; close?: string }>> = {
  ts: { open: '//' }, tsx: { open: '//' }, js: { open: '//' }, jsx: { open: '//' }, java: { open: '//' },
  c: { open: '//' }, cpp: { open: '//' }, cs: { open: '//' }, go: { open: '//' }, swift: { open: '//' },
  kt: { open: '//' }, rs: { open: '//' }, php: { open: '//' }, dart: { open: '//' },
  py: { open: '#' }, rb: { open: '#' }, sh: { open: '#' }, bash: { open: '#' }, zsh: { open: '#' },
  yaml: { open: '#' }, yml: { open: '#' }, toml: { open: '#' }, r: { open: '#' },
  html: { open: '<!--', close: '-->' }, xml: { open: '<!--', close: '-->' }, svg: { open: '<!--', close: '-->' },
  css: { open: '/*', close: '*/' }, scss: { open: '//' }, sass: { open: '//' }, less: { open: '//' },
  lua: { open: '--' }, sql: { open: '--' },
  el: { open: ';;' }, clj: { open: ';;' },
};

function commentSyntax(path: string): { open: string; close?: string } {
  return EXT_COMMENT[extensionOf(path)] ?? { open: '//' };
}

export function markerFor(path: string): string {
  const { open, close } = commentSyntax(path);
  return close ? `${open} SPOTME: <description> ${close}` : `${open} SPOTME: <description>`;
}

function markerPrefix(path: string): string {
  return `${commentSyntax(path).open} SPOTME:`;
}

export function renderWriteDenial(outcome: Extract<WriteOutcome, { type: 'trigger' }>, v: Vocab): string {
  const { write, difficulty } = outcome;
  const marker = markerFor(write.path);
  const scaffoldStep =
    write.kind === 'edit'
      ? `Edit \`${write.path}\` to add a \`${marker}\` comment at the location where the implementation should go.`
      : `Write the scaffold to \`${write.path}\` using the ${v.writeTool} tool. Include a \`${marker}\` comment where the implementation should go.`;
  return [
    `[SpotMe] Counter reached — time for an exercise!`,
    ``,
    `Follow these steps in order:`,
    `1. ${scaffoldStep}`,
    `2. Call \`spotme_exercise\` with the unit name, the file path, and difficulty "${difficulty}".`,
    `3. Display the full return value of \`spotme_exercise\` verbatim to the user (do not summarize).`,
  ].join('\n');
}

export function renderReady(e: Exercise, v: Vocab): string {
  const options: ReadonlyArray<readonly [CommandName, string]> = [
    ['hint', 'get a targeted hint'],
    ['solve', 'concede and let the agent finish'],
    ['skip', 'skip this exercise'],
    ['done', 'submit your implementation for review'],
  ];
  const width = Math.max(...options.map(([n]) => v.command(n).length + 2));
  return [
    `🏋️ Exercise ready: **${e.unit}**`,
    `Difficulty: ${e.difficulty} — ${difficultyLabel(e.difficulty)}`,
    `File: \`${e.path}\``,
    ``,
    `Edit the file in your editor. Replace the \`${markerPrefix(e.path)}\` marker with your implementation.`,
    ``,
    `Your options:`,
    ...options.map(([n, what]) => `  ${`\`${v.command(n)}\``.padEnd(width)} — ${what}`),
  ].join('\n');
}

export function renderRegisterRefusal(r: RegisterRefusal, v: Vocab): string {
  switch (r.why) {
    case 'off':
      return `SpotMe is off. Run ${v.command('on')} first.`;
    case 'busy':
      return busyText(r.current, v);
    case 'missingFile':
      return `Scaffold file not found at ${r.path}. Write the scaffold with the ${v.writeTool} tool first, then call spotme_exercise.`;
    case 'missingMarker':
      return `Scaffold file ${r.path} has no SPOTME: marker. Add a \`${markerFor(r.path)}\` comment where the human should implement, then call spotme_exercise again.`;
  }
}

function busyText(current: Exercise, v: Vocab): string {
  const names = (['done', 'solve', 'skip'] as const).map(v.command).join(', ');
  return `An exercise is already active: ${current.unit} (${current.path}). Finish it with ${names} first.`;
}

export const ENDED = '✅ Exercise closed. Counter reset. Resuming normal mode.';

export function renderStatus(s: State, root: ProjectRoot): string {
  const { mode, settings } = s;
  const lines = [
    `SpotMe: ${mode.kind === 'off' ? '⚪ off' : '🟢 on'}`,
    `Difficulty: ${settings.difficulty}`,
    `Trigger every: ${settings.every} code write(s)`,
    `Counter: ${mode.kind === 'idle' ? mode.count : 0}/${settings.every}`,
  ];
  if (mode.kind === 'awaitingScaffold') {
    lines.push(`Pending scaffold: ${mode.trigger.path} (waiting for spotme_exercise)`);
  }
  if (mode.kind === 'active') {
    lines.push(`Active exercise: ${mode.exercise.unit} (${mode.exercise.path})`);
  }
  lines.push(`Project: ${root}`);
  return lines.join('\n');
}

const HINT =
  'Give one targeted hint for the current SpotMe exercise. Point toward the approach without revealing the implementation. One paragraph max.';

const NO_EXERCISE: Readonly<Record<'done' | 'solve' | 'skip' | 'hint', string>> = {
  done: 'No active SpotMe exercise to review.',
  solve: 'No active SpotMe exercise to solve.',
  skip: 'No active SpotMe exercise to skip.',
  hint: 'No active SpotMe exercise to give a hint for.',
};

type Notice = Extract<CommandOutcome, { kind: 'notice' }>['notice'];
type Prompt = Extract<CommandOutcome, { kind: 'prompt' }>['prompt'];
type Refusal = Extract<CommandOutcome, { kind: 'refuse' }>['refusal'];

export function renderCommand(o: CommandOutcome, root: ProjectRoot, v: Vocab): string {
  switch (o.kind) {
    case 'notice':
      return renderNotice(o.notice, root);
    case 'prompt':
      return renderPrompt(o.prompt, v);
    case 'refuse':
      return renderRefusal(o.refusal, v);
  }
}

function renderNotice(n: Notice, root: ProjectRoot): string {
  if (n.type === 'on') {
    return `🏋️ SpotMe is on. Difficulty: ${n.settings.difficulty}. Triggering every ${n.settings.every} code write(s).`;
  }
  if (n.type === 'off') return '⏹️ SpotMe is off — normal coding resumed.';
  return renderStatus(n.state, root);
}

function renderPrompt(p: Prompt, v: Vocab): string {
  switch (p.type) {
    case 'done':
      return `Current SpotMe exercise: **${p.exercise.unit}** in \`${p.exercise.path}\`.\n\nRead the exercise file. Evaluate the user's implementation: (1) what they got right — 1-2 sentences, specific; (2) what could be better — concrete, no vague feedback; (3) next steps only if incomplete. Do NOT show your own solution. Resume the original task and complete any remaining code. Call \`spotme_end\` as the LAST thing you do.`;
    case 'solve':
      return `Current SpotMe exercise: **${p.exercise.unit}** in \`${p.exercise.path}\`.\n\nRead the exercise file. Write the solution (replace the SPOTME marker if still present, or improve what the user wrote). Briefly note the key pattern the user should remember. Resume the original task and complete any remaining code. Call \`spotme_end\` as the LAST thing you do.`;
    case 'skip':
      return `The human is skipping the SpotMe exercise **${p.exercise.unit}** in \`${p.exercise.path}\`. Resume the original task and complete the code normally. Call \`spotme_end\` as the LAST thing you do.`;
    case 'hint':
      return `Current SpotMe exercise: **${p.exercise.unit}** in \`${p.exercise.path}\`.\n\n${HINT}`;
    case 'skipScaffold':
      return `The human is skipping this SpotMe exercise before it started (\`${p.trigger.path}\`). Do not call \`spotme_exercise\`. Resume the original task and complete the code normally.`;
    case 'rep':
      return `The human wants a coding exercise. Write the scaffold for the next logical unit using the ${v.writeTool} tool (use a \`SPOTME: <description>\` marker in the file's comment syntax, such as \`// SPOTME:\` or \`# SPOTME:\`, where the human should implement), then call \`spotme_exercise\` with the unit name, file path, and difficulty "${p.difficulty}".`;
  }
}

function renderRefusal(r: Refusal, v: Vocab): string {
  switch (r.why) {
    case 'off':
      return `SpotMe is off. Run ${v.command('on')} first.`;
    case 'noExercise':
      return NO_EXERCISE[r.command];
    case 'scaffoldPending':
      return `The exercise scaffold at ${r.trigger.path} is not registered yet. Let the agent finish it, or run ${v.command('skip')} to cancel it.`;
    case 'busy':
      return busyText(r.current, v);
  }
}

export function relay(kind: CommandOutcome['kind'], text: string): string {
  return kind === 'prompt' ? text : `Show the following to the user verbatim and take no other action:\n\n${text}`;
}

export function commandFileBody(name: CommandName, argsToken: string | null): string {
  const args = argsToken === null ? 'set to any text the user typed after the command' : `"${argsToken}"`;
  return [
    `<!-- spotme:command ${name} ${argsToken ?? ''} -->`.replace(/ +-->$/, ' -->'),
    `Call the \`spotme_command\` tool with name "${name}" and args ${args}.`,
    `Follow its result exactly. If the tool is unavailable, run \`spotme ${name}${argsToken === null ? '' : ` ${argsToken}`}\` in the shell instead and follow its output.`,
    '',
  ].join('\n');
}

export function skillMarkdown(v: Vocab): string {
  const writeTools = v.writeTool === v.editTool ? `the ${v.writeTool} tool` : `the ${v.writeTool} or ${v.editTool} tool`;
  const c = v.command;
  return `# SpotMe — Gym Mode

You are in **SpotMe mode**. Your role shifts from "complete the code" to "set up the lift."

## Your job when SpotMe is active

When the harness intercepts a code-writing action and tells you it's time for an exercise:

1. **Do not write the implementation directly.**
2. Write the scaffold file using ${writeTools}. Include a \`SPOTME: <description>\` marker in the language's comment syntax (\`// SPOTME:\`, \`# SPOTME:\`, \`-- SPOTME:\`) where the human should implement.
3. **Call \`spotme_exercise\`** with the unit name, file path, and difficulty.
4. Display the full return value of \`spotme_exercise\` verbatim to the user (do not summarize).
5. **Stop.** Wait for the user's next command.

## Scaffold rules by difficulty

| Difficulty | You provide | Human provides |
|------------|-------------|----------------|
| \`lite\` | Full function signature, docstring, imports, empty stubs | Just the body / core logic |
| \`medium\` | Signature only + \`SPOTME: <spec>\` comment | All logic including structure |
| \`hard\` | Plain English spec in a comment block only | Everything — file layout, signature, logic |

The \`SPOTME: <description>\` marker must clearly say what the human should implement, in one sentence.

Example (Python, medium):
\`\`\`python
def calculate_discount(price: float, tier: str) -> float:
    # SPOTME: return the discounted price given tier (bronze=5%, silver=10%, gold=20%)
    pass
\`\`\`

Example (TypeScript, hard):
\`\`\`typescript
// SPOTME: Implement a rate limiter middleware that allows N requests per window.
// Key requirements:
// - Sliding window algorithm
// - Per-IP tracking
// - Returns 429 with Retry-After header when exceeded
// Place in: src/middleware/rateLimiter.ts
\`\`\`

## Tools

| Tool | Purpose |
|------|---------|
| \`spotme_exercise\` | Register an exercise after writing the scaffold. Args: unit name, file path, difficulty. |
| \`spotme_status\` | Returns current SpotMe state (on/off, difficulty, counter, pending scaffold, active exercise). |
| \`spotme_end\` | Close the current exercise. **Must be called as the LAST thing** after done/solve/skip. |
| \`spotme_command\` | Run a SpotMe slash command (on, off, status, done, hint, solve, skip, rep) and follow its result. |

Without these tools, run the same operations in the shell: \`spotme exercise --unit <name> --file <path> --difficulty <d>\`, \`spotme status\`, \`spotme end\`, \`spotme <command> [args]\`.

## After calling \`spotme_exercise\`

Stop. Do not add explanation, do not hint. Let the human work.

## SpotMe commands

The human types ${c('on')}, ${c('off')}, ${c('status')}, ${c('done')}, ${c('hint')}, ${c('solve')}, ${c('skip')} or ${c('rep')}. When one reaches you, call \`spotme_command\` with its name and arguments and follow the result exactly. When the result says to show text verbatim, show it and do nothing else.

## When the human submits ${c('done')}

1. Read the exercise file named in the \`spotme_command\` result.
2. Evaluate the user's implementation:
   - **What they got right** — 1–2 sentences, specific
   - **What's missing or could be better** — concrete, directed (no vague "consider edge cases")
   - **Next steps** — only if the implementation is incomplete or has a follow-up
3. **Do not show what you would have written.** Feedback only.
4. If the project has tests: run them scoped to changed files and include results.
5. Resume the original task and complete any remaining code.
6. Call \`spotme_end\` as the **LAST** thing you do.

## When the human asks for ${c('hint')}

Give one targeted hint. Point toward the approach without solving it. One paragraph max.

## When the human runs ${c('solve')}

1. Read the exercise file.
2. Write the solution (replace the SPOTME marker if still present, or improve what the user wrote).
3. Briefly note the key pattern the user should remember.
4. Resume the original task and complete any remaining code.
5. Call \`spotme_end\` as the **LAST** thing you do.

## When the human runs ${c('skip')}

Resume the original task and complete the code normally. No comment, no stats. Call \`spotme_end\` as the **LAST** thing you do when an exercise was active.

## When the human runs ${c('rep')}

The human wants an exercise on-demand (outside the counter cycle). Write the scaffold for the next logical unit, then call \`spotme_exercise\`.

## Session awareness

- If the human asks for ${c('status')}, call \`spotme_status\` and display the result.
- Small trivial units (one-liner assignments, boilerplate imports) — skip automatically, don't trigger exercises for those.
`;
}

export const SKILL_DESCRIPTION =
  'Gym mode for agentic coding. When active, hands off implementation exercises to the human instead of completing them. Tracks difficulty and reviews submitted work.';
