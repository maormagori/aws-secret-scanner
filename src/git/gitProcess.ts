import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';

export const KILL_GRACE_PERIOD_MS = 2000;

export interface GitProcessOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdinLines: string[];
  signal?: AbortSignal;
}

export interface GitExit {
  // null when we killed the process or a signal did.
  exitCode: number | null;
  stderr: string;
}

export interface GitProcess {
  stdoutLines: AsyncIterable<string>;
  waitForExit(): Promise<GitExit>;
  kill(): void;
}

// git runs in its own process group so that a kill also reaches its helpers (e.g. `git-remote-https`).
// A helper can outlive git and keep the pipes open, so kill() never waits on git or the pipes.
export function spawnGitProcess(args: string[], options: GitProcessOptions): GitProcess {
  const child = spawn('git', args, { cwd: options.cwd, env: options.env, detached: true });
  let stderr = '';
  let wasKilled = false;
  let hasClosed = false;

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // A failed spawn is reported through the exit code (null) below; without a listener it would crash the process.
  child.on('error', () => undefined);
  const closeCode = new Promise<number | null>((resolve) => child.on('close', resolve));
  child.on('close', () => {
    hasClosed = true;
    options.signal?.removeEventListener('abort', kill);
  });
  writeStdin(child.stdin, options.stdinLines);
  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  // Created now, not when the caller starts reading: an iterator made after the reader closed would never end.
  const stdoutLines = lineReader[Symbol.asyncIterator]();

  function kill(): void {
    // Abort and the caller's cleanup can both call kill; after a normal close there is nothing left to stop.
    if (wasKilled || hasClosed) {
      return;
    }
    wasKilled = true;
    options.signal?.removeEventListener('abort', kill);
    signalGroup(child.pid, 'SIGTERM');
    // Closing our ends lets `close` fire even while a helper still holds the other ends. A destroyed stream
    // never emits `end`, so the line reader is closed by hand to end the caller's loop.
    lineReader.close();
    child.stdout.destroy();
    child.stderr.destroy();
    setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_PERIOD_MS).unref();
  }

  if (options.signal?.aborted === true) {
    kill();
  }
  options.signal?.addEventListener('abort', kill, { once: true });

  return {
    stdoutLines,
    async waitForExit() {
      const exitCode = await closeCode;
      // git may have exited 0 before the kill while we had not read all its output yet.
      return { exitCode: wasKilled ? null : exitCode, stderr };
    },
    kill,
  };
}

function signalGroup(groupId: number | undefined, signalName: NodeJS.Signals): void {
  // undefined when the spawn itself failed: there is no process to signal.
  if (groupId === undefined) {
    return;
  }
  try {
    process.kill(-groupId, signalName);
  } catch (error) {
    const isGroupGone = error instanceof Error && 'code' in error && error.code === 'ESRCH';
    if (!isGroupGone) {
      throw error;
    }
  }
}

function writeStdin(stdin: Writable, stdinLines: string[]): void {
  // git may exit before reading all of stdin (e.g. a bad repo dir); the exit code reports that, not EPIPE.
  stdin.on('error', () => undefined);
  stdin.end(stdinLines.map((line) => `${line}\n`).join(''));
}
