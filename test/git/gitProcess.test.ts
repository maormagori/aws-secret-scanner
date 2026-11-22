import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { spawnGitProcess } from '../../src/git/gitProcess.js';

// The alias shell starts a background `sleep` that inherits stdout, prints its pid and exits, so git exits too
// while the helper keeps the pipe open: the same shape as git leaving `git-remote-https` behind.
const LEFTOVER_HELPER_ALIAS = 'alias.leave-helper=!sleep 30 & echo $!';
const TIME_FOR_GIT_TO_EXIT_MS = 300;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('gitProcess', () => {
  it('settles and kills the helper when git exited but a helper still holds stdout', async () => {
    const gitProcess = spawnGitProcess(['-c', LEFTOVER_HELPER_ALIAS, 'leave-helper'], {
      env: process.env,
      stdinLines: [],
    });
    const firstLine = await gitProcess.stdoutLines[Symbol.asyncIterator]().next();
    const helperPid = Number(firstLine.value);
    await delay(TIME_FOR_GIT_TO_EXIT_MS);

    gitProcess.kill();

    expect(await gitProcess.waitForExit()).toMatchObject({ exitCode: null });
    expect(isProcessAlive(helperPid)).toBe(false);
  }, 3000);

  it('reports a normal exit with its exit code', async () => {
    const gitProcess = spawnGitProcess(['--version'], { env: process.env, stdinLines: [] });
    const lines: string[] = [];
    for await (const line of gitProcess.stdoutLines) {
      lines.push(line);
    }

    expect(await gitProcess.waitForExit()).toEqual({ exitCode: 0, stderr: '' });
    expect(lines[0]).toMatch(/^git version /);
  });
});
