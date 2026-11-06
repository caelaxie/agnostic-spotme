import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { TSchema } from 'typebox';
import { COMMAND_NAMES } from './engine.ts';
import type { ProjectRoot } from './engine.ts';
import { extractWrites } from './harness.ts';
import { HARNESSES } from './harnesses.ts';
import { COMMAND_SPECS } from './messages.ts';
import { openSpotMe, TOOLS } from './session.ts';
import type { ParamSpec, SpotMe, ToolName } from './session.ts';
import { canonicalRoot } from './store.ts';

function toTypebox(p: ParamSpec): TSchema {
  const schema = p.type === 'enum' ? Type.Union(p.values.map((v) => Type.Literal(v)), { description: p.description }) : Type.String({ description: p.description });
  return p.optional ? Type.Optional(schema) : schema;
}

const label = (name: string) => name.replace(/^spotme_/, 'SpotMe ').replace(/^./, (c) => c.toUpperCase());

/** Pi loads this in-process. Commands run here: notices go to the UI, prompts go to the model. */
export default function spotme(pi: ExtensionAPI): void {
  const h = HARNESSES.pi;
  const sessions = new Map<string, SpotMe>();
  const at = (cwd: string | undefined): SpotMe => {
    const root: ProjectRoot = canonicalRoot(cwd ?? process.cwd());
    let sm = sessions.get(root);
    if (!sm) sessions.set(root, (sm = openSpotMe(root, h.vocab)));
    return sm;
  };

  for (const [name, spec] of Object.entries(TOOLS) as [ToolName, (typeof TOOLS)[ToolName]][]) {
    pi.registerTool({
      name,
      label: label(name),
      description: spec.description,
      parameters: Type.Object(Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, toTypebox(p as ParamSpec)]))),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const reply = await at(ctx.cwd).callTool(name, params);
        return { content: [{ type: 'text', text: reply.text }], details: {}, ...(reply.ok ? {} : { isError: true }) };
      },
    });
  }

  for (const name of COMMAND_NAMES) {
    pi.registerCommand(`spotme:${name}`, {
      description: COMMAND_SPECS[name].summary,
      handler: async (args, ctx) => {
        const reply = await at(ctx.cwd).command(name, args ?? '');
        if (reply.kind === 'prompt') pi.sendUserMessage(reply.text);
        else ctx.ui.notify(reply.text, reply.kind === 'refuse' ? 'warning' : 'info');
      },
    });
  }

  pi.on('tool_call', async (event, ctx) => {
    const verdict = await at(ctx.cwd).onWrite(extractWrites(h.writes, event.toolName, event.input));
    return verdict.allow ? undefined : { block: true, reason: verdict.reason };
  });
}
