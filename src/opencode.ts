import { extractWrites } from './harness.ts';
import { HARNESSES } from './harnesses.ts';
import { openSpotMe } from './session.ts';
import { canonicalRoot } from './store.ts';

export interface SpotMePluginOptions {
  readonly root?: string;
  readonly stateDir?: string;
}

/** The slice of the OpenCode 2.x `setup` plugin API this plugin uses, as observed in 2.0.12. */
export interface OpenCodeToolCall {
  readonly tool: string;
  readonly input: unknown;
}
export interface OpenCodeApi {
  readonly location?: { readonly directory?: unknown };
  readonly options?: unknown;
  readonly tool: { hook(name: 'execute.before', callback: (call: OpenCodeToolCall) => Promise<void>): unknown };
}

function optionsFrom(raw: unknown): SpotMePluginOptions {
  if (typeof raw !== 'object' || raw === null) return {};
  const o = raw as Record<string, unknown>;
  return {
    ...(typeof o.root === 'string' ? { root: o.root } : {}),
    ...(typeof o.stateDir === 'string' ? { stateDir: o.stateDir } : {}),
  };
}

export function spotmePlugin(baked: SpotMePluginOptions = {}) {
  return {
    id: 'spotme',
    async setup(api: OpenCodeApi): Promise<void> {
      const opts = { ...optionsFrom(api.options), ...baked };
      const located = typeof api.location?.directory === 'string' ? api.location.directory : undefined;
      const env = opts.stateDir ? { ...process.env, SPOTME_STATE_DIR: opts.stateDir } : process.env;
      const h = HARNESSES.opencode;
      const sm = openSpotMe(canonicalRoot(opts.root ?? located ?? process.cwd()), h.vocab, { env });
      // OpenCode runs execute.before hooks in sequence and a rejected hook fails the tool call,
      // which is the only way 2.0.12 offers to refuse one.
      await api.tool.hook('execute.before', async (call) => {
        const verdict = await sm.onWrite(extractWrites(h.writes, call.tool, call.input));
        if (!verdict.allow) throw new Error(verdict.reason);
      });
    },
  };
}

export default spotmePlugin();
