// 시험 보조: 프로세스를 띄우고, 끝나기를 기다리고, 남은 프로세스가 없는지 확인한다.
// 제품 코드가 아니다. src 는 이 파일을 import 하지 않는다.
//
// 쓰는 법:
//   const procs = createProcTracker({ label: 'mesh' });
//   const server = procs.spawnDist('entry/server.js', ['--port', '8787'], { name: 'server' });
//   await server.waitForOutput(/listening/, { timeoutMs: 5000 });
//   ...
//   await server.stop({ signal: 'SIGTERM', timeoutMs: 5000 });
//   await procs.assertNoneLeft();     // 남은 프로세스가 있으면 던진다
//   await procs.dispose();            // 남은 것을 지우고 종료 훅을 뗀다
//
// dist 뿌리는 환경 변수 AGENT_CHAT_DIST 로 바꾼다(묶음별 빌드 폴더). 기본은 <저장소>/dist 다.
//
// 주의: 띄우는 프로세스는 신호 처리기를 건 **뒤에** 준비 문구를 출력해야 한다. 문구가 먼저 나오면
// waitForOutput 직후의 stop() 이 처리기보다 먼저 닿아 프로세스가 기본 동작으로 죽는다.

import { AssertionError } from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const OUTPUT_TAIL_IN_ERRORS = 2000;
// 프로세스가 끝난 뒤 남은 출력을 기다리는 시간. 손자가 출력 파이프를 물고 있으면 'close' 가 오지 않는다.
const OUTPUT_DRAIN_MS = 250;
const PARENT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** 빌드 결과의 뿌리 폴더. 상대 경로는 저장소 뿌리 기준이다. */
export function distRoot(env = process.env) {
  const override = env.AGENT_CHAT_DIST;
  return override ? path.resolve(REPO_ROOT, override) : path.join(REPO_ROOT, 'dist');
}

/** 빌드 결과 안의 파일 경로. 예: distPath('entry', 'mcp.js') */
export function distPath(...segments) {
  return path.join(distRoot(), ...segments);
}

/** import() 에 넣을 수 있는 file URL. 예: await import(distUrl('protocol/index.js')) */
export function distUrl(...segments) {
  return pathToFileURL(distPath(...segments)).href;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 그 pid 의 프로세스가 지금 있는가. 권한이 없어 신호를 못 보내는 경우도 "있다"로 센다. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 그 프로세스 그룹에 남은 프로세스가 있는가 (POSIX 전용). */
function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function tail(text) {
  return text.length > OUTPUT_TAIL_IN_ERRORS ? `…${text.slice(-OUTPUT_TAIL_IN_ERRORS)}` : text;
}

function mergedEnv(extra) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extra ?? {})) {
    // undefined 를 주면 그 변수를 지운다. 부모의 설정이 시험에 새지 않게 할 때 쓴다.
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/**
 * 프로세스 추적기를 만든다. 전역 상태를 두지 않으므로 시험마다 하나씩 만든다.
 *
 * @param {object} [options]
 * @param {string} [options.label] 오류 문구에 붙일 이름.
 * @param {boolean} [options.processGroups] 자식을 새 프로세스 그룹으로 띄운다. 자식이 띄운 손자까지
 *   "남은 프로세스"로 잡기 위해서다. 기본은 POSIX 에서 참, Windows 에서 거짓.
 * @param {boolean} [options.handleSignals] 부모가 SIGINT·SIGTERM·SIGHUP 을 받으면 자식을 지우고 같은 신호로 끝난다. 기본 참.
 */
export function createProcTracker(options = {}) {
  const label = options.label ?? 'proc';
  const useGroups = options.processGroups ?? process.platform !== 'win32';
  const handleSignals = options.handleSignals ?? true;
  /** @type {Set<ReturnType<typeof makeHandle> | ReturnType<typeof makeExternal>>} */
  const entries = new Set();
  let disposed = false;

  function makeHandle(command, args, opts) {
    const name = opts.name ?? path.basename(String(command));
    const outputLimit = opts.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    const startedAt = Date.now();
    const output = { stdout: '', stderr: '' };
    const listeners = new Set();
    let exit = null;
    let spawnError = null;

    const child = spawn(command, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: mergedEnv(opts.env),
      stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
      detached: useGroups,
      windowsHide: true,
    });
    const pid = child.pid ?? null;

    const notify = () => {
      for (const listener of [...listeners]) listener();
    };
    const collect = (stream) => (chunk) => {
      let next = output[stream] + chunk;
      if (next.length > outputLimit) next = next.slice(next.length - outputLimit);
      output[stream] = next;
      notify();
    };
    child.stdout?.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr?.setEncoding('utf8').on('data', collect('stderr'));
    // 닫힌 자식의 stdin 에 쓰면 EPIPE 가 난다. 시험 프로세스가 그것으로 죽지 않게 한다.
    child.stdin?.on('error', () => {});

    // status 는 프로세스가 죽은 순간에, exit 는 남은 출력까지 받은 뒤에 정해진다.
    let status = null;
    let markDied = () => {};
    const died = new Promise((resolve) => {
      markDied = resolve;
    });
    const exited = new Promise((resolve) => {
      let drainTimer = null;
      const finish = () => {
        if (exit !== null || status === null) return;
        if (drainTimer !== null) clearTimeout(drainTimer);
        exit = status;
        notify();
        resolve(exit);
      };
      child.once('error', (error) => {
        spawnError = error;
        status ??= { code: null, signal: null, durationMs: Date.now() - startedAt, error };
        markDied();
        finish();
      });
      child.once('exit', (code, signal) => {
        status ??= { code, signal, durationMs: Date.now() - startedAt };
        markDied();
        drainTimer = setTimeout(finish, OUTPUT_DRAIN_MS);
      });
      child.once('close', (code, signal) => {
        status ??= { code, signal, durationMs: Date.now() - startedAt };
        markDied();
        finish();
      });
    });

    function describe() {
      return `${label}/${name}(pid ${pid ?? '없음'})`;
    }

    function failure(what) {
      return new Error(
        `${describe()}: ${what}\n--- stdout ---\n${tail(output.stdout)}\n--- stderr ---\n${tail(output.stderr)}`,
      );
    }

    function match(pattern, stream) {
      const text = stream === 'both' ? `${output.stdout}\n${output.stderr}` : output[stream];
      if (typeof pattern === 'string') return text.includes(pattern) ? pattern : null;
      pattern.lastIndex = 0;
      return pattern.exec(text);
    }

    const handle = {
      name,
      pid,
      child,
      get stdin() {
        return child.stdin;
      },
      stdout: () => output.stdout,
      stderr: () => output.stderr,
      /** 끝났으면 {code, signal, durationMs}, 아니면 null. */
      get exit() {
        return exit;
      },
      get spawnError() {
        return spawnError;
      },

      /** 이 프로세스(그룹을 쓰면 그 그룹의 누구든)가 아직 있는가. */
      alive() {
        if (pid === null) return false;
        if (status === null) return true;
        return useGroups ? isGroupAlive(pid) : false;
      },

      /**
       * 출력에 문자열이나 정규식이 나타날 때까지 기다린다.
       * @returns {Promise<RegExpExecArray | string>}
       */
      waitForOutput(pattern, { timeoutMs = 10_000, stream = 'stdout' } = {}) {
        return new Promise((resolve, reject) => {
          let timer = null;
          const finish = (fn, value) => {
            listeners.delete(check);
            if (timer !== null) clearTimeout(timer);
            fn(value);
          };
          const check = () => {
            const found = match(pattern, stream);
            if (found !== null) finish(resolve, found);
            else if (exit !== null) finish(reject, failure(`${String(pattern)} 이(가) 나오기 전에 끝났다`));
          };
          listeners.add(check);
          timer = setTimeout(
            () => finish(reject, failure(`${timeoutMs}ms 안에 ${String(pattern)} 이(가) 나오지 않았다`)),
            timeoutMs,
          );
          check();
        });
      },

      /** 끝나기를 기다린다. 기한을 넘기면 던진다(죽이지 않는다). */
      async waitForExit({ timeoutMs = 10_000 } = {}) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure(`${timeoutMs}ms 안에 끝나지 않았다`)), timeoutMs);
        });
        try {
          // 기한은 프로세스가 죽은 때로 잰다. 남은 출력을 받는 시간은 기한에 넣지 않는다.
          await Promise.race([died, timeout]);
          const result = await exited;
          if (result.error) throw failure(`실행하지 못했다: ${result.error.message}`);
          return result;
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      },

      /** 이 프로세스에만 신호를 보낸다. 보냈으면 참. */
      kill(signal = 'SIGTERM') {
        if (pid === null || status !== null) return false;
        return child.kill(signal);
      },

      /** 이 프로세스와 그것이 띄운 프로세스(같은 그룹)에 신호를 보낸다. */
      killTree(signal = 'SIGKILL') {
        if (pid === null) return false;
        if (!useGroups) return status === null ? child.kill(signal) : false;
        try {
          process.kill(-pid, signal);
          return true;
        } catch {
          return false;
        }
      },

      /**
       * 신호를 보내고 끝나기를 기다린다. 기한을 넘기면 그룹째 SIGKILL 한다.
       * @returns {Promise<{code: number|null, signal: string|null, durationMs: number, forced: boolean, stopMs: number}>}
       *   forced 가 참이면 기한 안에 스스로 끝나지 않은 것이다. stopMs 는 신호를 보낸 뒤 끝날 때까지다.
       */
      async stop({ signal = 'SIGTERM', timeoutMs = 5_000 } = {}) {
        const sentAt = Date.now();
        handle.kill(signal);
        let forced = false;
        let timer = null;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const first = await Promise.race([died, timeout]);
        if (timer !== null) clearTimeout(timer);
        if (first === 'timeout' && status === null) {
          forced = true;
          handle.killTree('SIGKILL');
        }
        const result = await exited;
        return { ...result, forced, stopMs: Math.max(0, startedAt + result.durationMs - sentAt) };
      },

      describe,
    };
    return handle;
  }

  function makeExternal(pid, name) {
    return {
      name,
      pid,
      alive: () => isPidAlive(pid),
      killTree(signal = 'SIGKILL') {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      },
      describe: () => `${label}/${name}(pid ${pid})`,
    };
  }

  function killAllSync(signal = 'SIGKILL') {
    for (const entry of entries) {
      if (entry.alive()) entry.killTree(signal);
    }
  }

  const onParentExit = () => killAllSync('SIGKILL');
  const signalHandlers = new Map();
  function removeHooks() {
    process.removeListener('exit', onParentExit);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.clear();
  }
  process.on('exit', onParentExit);
  if (handleSignals) {
    for (const signal of PARENT_SIGNALS) {
      const handler = () => {
        killAllSync('SIGKILL');
        removeHooks();
        // 기본 동작(그 신호로 종료)을 되살린다.
        process.kill(process.pid, signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  const tracker = {
    label,

    /** 명령을 띄우고 추적한다. opts: {name, cwd, env, stdin, outputLimit} */
    spawn(command, args = [], opts = {}) {
      if (disposed) throw new Error(`${label}: dispose() 뒤에는 띄울 수 없다`);
      const handle = makeHandle(command, args, opts);
      entries.add(handle);
      return handle;
    },

    /** 이 시험을 돌리는 Node 로 스크립트를 띄운다. opts.nodeArgs 로 Node 옵션을 준다. */
    spawnNode(script, args = [], opts = {}) {
      return tracker.spawn(process.execPath, [...(opts.nodeArgs ?? []), script, ...args], {
        name: path.basename(String(script)),
        ...opts,
      });
    },

    /** 빌드 결과(dist) 안의 스크립트를 띄운다. 예: spawnDist('entry/server.js', ['--port', '0']) */
    spawnDist(relativePath, args = [], opts = {}) {
      return tracker.spawnNode(distPath(relativePath), args, opts);
    },

    /**
     * 띄우고 끝날 때까지 기다려 결과를 돌려준다. 기한을 넘기면 그룹째 죽이고 던진다.
     * @returns {Promise<{code: number|null, signal: string|null, durationMs: number, stdout: string, stderr: string}>}
     */
    async run(command, args = [], opts = {}) {
      const handle = tracker.spawn(command, args, opts);
      try {
        const result = await handle.waitForExit({ timeoutMs: opts.timeoutMs ?? 30_000 });
        return { ...result, stdout: handle.stdout(), stderr: handle.stderr() };
      } catch (error) {
        handle.killTree('SIGKILL');
        throw error;
      }
    },

    /** 다른 수단(예: MCP SDK 의 stdio 전송)이 띄운 프로세스를 pid 로 추적에 넣는다. */
    trackPid(pid, name = `pid-${pid}`) {
      const entry = makeExternal(pid, name);
      entries.add(entry);
      return entry;
    },

    list() {
      return [...entries].map((entry) => ({ name: entry.name, pid: entry.pid, alive: entry.alive() }));
    },

    /** 아직 남아 있는 프로세스. */
    leftovers() {
      return [...entries].filter((entry) => entry.alive()).map((entry) => ({ name: entry.name, pid: entry.pid }));
    },

    /**
     * 추적한 프로세스가 하나도 남지 않았는지 확인한다. 남아 있으면 AssertionError 를 던진다.
     * 죽이지 않는다. 시험이 실패를 보고한 뒤 dispose() 가 정리한다.
     * @param {object} [options]
     * @param {number} [options.graceMs] 이 시간까지는 사라지기를 기다린다. 기본 0.
     */
    async assertNoneLeft({ graceMs = 0, pollMs = 25 } = {}) {
      const deadline = Date.now() + graceMs;
      let left = tracker.leftovers();
      while (left.length > 0 && Date.now() < deadline) {
        await delay(pollMs);
        left = tracker.leftovers();
      }
      if (left.length > 0) {
        const names = left.map((entry) => `${entry.name}(pid ${entry.pid})`).join(', ');
        throw new AssertionError({
          message: `${label}: 남은 프로세스 ${left.length}개: ${names}`,
          actual: left,
          expected: [],
          operator: 'assertNoneLeft',
        });
      }
    },

    /** 남은 프로세스에 신호를 보낸다(그룹째). 보낸 대상을 돌려준다. */
    killAll(signal = 'SIGKILL') {
      const left = tracker.leftovers();
      killAllSync(signal);
      return left;
    },

    /**
     * 남은 프로세스를 SIGKILL 하고 사라지기를 기다린 뒤 종료 훅을 뗀다. 시험의 마지막에 한 번 부른다.
     * @returns {Promise<{name: string, pid: number|null}[]>} 이 호출이 죽여야 했던 프로세스. 비어 있어야 정상이다.
     */
    async dispose({ graceMs = 2_000 } = {}) {
      const killed = tracker.killAll('SIGKILL');
      const deadline = Date.now() + graceMs;
      while (tracker.leftovers().length > 0 && Date.now() < deadline) await delay(25);
      removeHooks();
      disposed = true;
      return killed;
    },
  };
  return tracker;
}
