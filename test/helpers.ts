import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { ProjectRoot } from '../src/engine.ts';
import { canonicalRoot } from '../src/store.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'spotme-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export interface Sandbox {
  readonly root: ProjectRoot;
  readonly stateDir: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A git-looking project, its own state dir and HOME, so nothing touches the real user config. */
export function sandbox(): Sandbox {
  const base = tempDir();
  const project = join(base, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  const stateDir = join(base, 'state');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    SPOTME_STATE_DIR: stateDir,
    XDG_DATA_HOME: join(base, 'data'),
  };
  return { root: canonicalRoot(project), stateDir, home, env };
}
