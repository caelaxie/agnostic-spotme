import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isCommandName } from './engine.ts';
import { extractWrites, parsePromptCommand } from './harness.ts';
import type { HookEvent, HookReply } from './harness.ts';
import { HARNESSES } from './harnesses.ts';
import type { HarnessId } from './harnesses.ts';
import { openSpotMe } from './session.ts';
import { canonicalRoot } from './store.ts';

const PASS: HookReply = { stdout: '', exitCode: 0 };

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function capture(env: NodeJS.ProcessEnv, harness: HarnessId, event: HookEvent, stdin: unknown, reply: HookReply): void {
  if (!env.SPOTME_CAPTURE_DIR) return;
  try {
    mkdirSync(env.SPOTME_CAPTURE_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), harness, event, stdin, stdout: reply.stdout });
    appendFileSync(join(env.SPOTME_CAPTURE_DIR, 'hooks.jsonl'), `${line}\n`);
  } catch {
  }
}

export async function runHook(
  id: HarnessId,
  event: HookEvent,
  stdin: string,
  env: NodeJS.ProcessEnv,
  rootFlag?: string,
): Promise<HookReply> {
  const h = HARNESSES[id];
  const proto = h.hooks;
  if (!proto) return PASS;
  const json = tryParse(stdin);
  let reply: HookReply = proto.pass(event);
  try {
    const payload = proto.parse(event, json, env);
    const dir = rootFlag ?? payload?.dir;
    if (payload && dir) {
      const sm = openSpotMe(canonicalRoot(dir), h.vocab, { env });
      if (event === 'write') {
        const verdict = await sm.onWrite(extractWrites(h.writes, payload.toolName ?? '', payload.toolInput));
        if (!verdict.allow) reply = proto.deny(verdict.reason);
      } else {
        const cmd = parsePromptCommand(payload.prompt ?? '', isCommandName);
        if (cmd && (await sm.peekCommand(cmd.name, cmd.args)) !== 'prompt') {
          reply = proto.stop((await sm.command(cmd.name, cmd.args)).text);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`spotme: hook error, passing: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  capture(env, id, event, json, reply);
  return reply;
}
