import { HARNESSES, GENERIC_VOCAB } from './harnesses.ts';
import type { HarnessId } from './harnesses.ts';
import { skillMarkdown } from './messages.ts';
import { openSpotMe, toJsonSchema, TOOLS } from './session.ts';
import type { SpotMe } from './session.ts';
import { canonicalRoot, rootDirFrom } from './store.ts';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface ServeOptions {
  readonly harness?: HarnessId;
  readonly rootFlag?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly input: AsyncIterable<string | Buffer>;
  /** stdout. Logs go to stderr only; anything else on stdout corrupts the protocol. */
  readonly write: (text: string) => void;
  readonly version: string;
}

type Id = string | number;
type Response =
  | { readonly jsonrpc: '2.0'; readonly id: Id | null; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: Id | null; readonly error: { readonly code: number; readonly message: string } };

const ok = (id: Id, result: unknown): Response => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id | null, code: number, message: string): Response => ({ jsonrpc: '2.0', id, error: { code, message } });

const field = (x: unknown, k: string): unknown => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>)[k] : undefined);

/** One JSON-RPC message in, at most one response out. Notifications and stray responses yield null. */
export function createMcpHandler(opts: Omit<ServeOptions, 'input' | 'write'>): (message: unknown) => Promise<Response | null> {
  const vocab = opts.harness ? HARNESSES[opts.harness].vocab : GENERIC_VOCAB;
  let session: SpotMe | null = null;
  const open = () => (session ??= openSpotMe(canonicalRoot(rootDirFrom(opts.rootFlag, opts.env, opts.cwd)), vocab, { env: opts.env }));

  return async (message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return fail(null, -32600, 'Invalid Request');
    const id = field(message, 'id');
    const method = field(message, 'method');
    if (typeof method !== 'string') return null;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const params = field(message, 'params');
    switch (method) {
      case 'initialize': {
        const asked = field(params, 'protocolVersion');
        const protocolVersion = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
        return ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'spotme', version: opts.version },
          instructions: skillMarkdown(vocab),
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: Object.entries(TOOLS).map(([name, spec]) => ({ name, description: spec.description, inputSchema: toJsonSchema(spec) })),
        });
      case 'tools/call': {
        const name = field(params, 'name');
        if (typeof name !== 'string') return fail(id, -32602, 'tools/call needs a tool name');
        try {
          const reply = await open().callTool(name, field(params, 'arguments') ?? {});
          return ok(id, { content: [{ type: 'text', text: reply.text }], isError: !reply.ok });
        } catch (e) {
          return ok(id, { content: [{ type: 'text', text: `SpotMe error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
        }
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  };
}

/** Newline-delimited JSON-RPC over stdio, handled in arrival order. */
export async function serveMcp(opts: ServeOptions): Promise<void> {
  const handle = createMcpHandler(opts);
  let buffer = '';
  const line = async (text: string) => {
    if (!text.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      opts.write(`${JSON.stringify(fail(null, -32700, 'Parse error'))}\n`);
      return;
    }
    const response = await handle(message);
    if (response) opts.write(`${JSON.stringify(response)}\n`);
  };
  for await (const chunk of opts.input) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      await line(text);
    }
  }
  await line(buffer);
}
