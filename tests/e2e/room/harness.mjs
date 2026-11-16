// 방 조율 하네스(V-L12). 자체 호스팅 서버, 시험용 프록시, 참가자 프로세스(peer.mjs)를 띄우고 다룬다.
// 참가자 프로세스 안에서 제품의 하위 모듈 실물과 room-session 이 돈다. MCP 는 없다. 제품 코드가 아니다.
//
// ── 쓰는 법 (시나리오 스크립트 안에서) ───────────────────────────────────────
//
//   import { startStack, newRoomId, until } from './harness.mjs';
//
//   const stack = await startStack({ label: 'v-l12' });          // 서버(빈 포트) + 프록시(빈 포트) + 임시 AGENT_CHAT_HOME
//   const room = newRoomId();
//   const alice = await stack.peer('alice');                      // 참가자 프로세스를 띄운다(아직 방에 없다)
//   const created = await alice.call('create', { room });         // session.create 의 결과
//   const bob = await stack.peer('bob');
//   const joined = await bob.call('join', { room });              // 기본 기한 45초(입장은 최악의 경우 약 40초다)
//   const sent = await alice.call('send', { text: 'hi' });        // session.sendChat
//   await bob.event((e) => e.t === 'inbox' && e.kind === 'chat'); // 수신함에 넣은 사건(본문 없음)
//   const status = await bob.call('status');                      // session.status()
//   const info = await bob.call('replica');                       // { elapsed_ms, fingerprint, count, ids, presences, … }
//   bob.logs('state.resync')                                      // 제품이 남긴 진단 사건
//   stack.proxy.addRule({ pair: ['alice', 'bob'], action: 'signal', op: 'drop' });   // tests/support/signal-proxy.mjs
//   await alice.leave();                                          // session.leave 뒤 프로세스를 끝낸다(종료 코드 0 확인)
//   await bob.kill();                                             // bye 없이 죽인다
//   await stack.close();                                          // 남은 프로세스가 있으면 던진다. 임시 홈을 지운다
//
//   stack.url   참가자에게 주는 주소(프록시).   stack.serverUrl   서버에 바로 붙는 주소.   stack.home(name)   그 참가자의 임시 홈
//
// 빌드 결과는 <저장소>/dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 준다(예: AGENT_CHAT_DIST=.work/w6a/dist).
// 포트는 모두 0(빈 포트)이다. 참가자의 기록 파일은 임시 폴더에만 생긴다. 실제 사용자 홈을 쓰지 않는다.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, createProcTracker, delay } from '../../support/proc.mjs';
import { startSignalProxy } from '../../support/signal-proxy.mjs';

const PEER_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'room', 'peer.mjs');
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 무작위 방 ID(16자). 기록과 출력에 남기지 않는다. */
export function newRoomId() {
  let text = '';
  while (text.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte >= 252) continue;
      text += ALNUM[byte % 36];
      if (text.length === 16) break;
    }
  }
  return text;
}

export { delay };

/** 조건이 참이 될 때까지 기다린다. 기한을 넘기면 던진다. 조건이 돌려준 참인 값을 돌려준다. */
export async function until(condition, what, timeoutMs = 10_000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`);
    await delay(pollMs);
  }
}

/** 참가자 프로세스 하나를 감싼다. stdout 의 EVT·LOG 줄을 읽어 모은다. */
function wrapPeer(proc, name) {
  const events = [];
  const logLines = [];
  const waiters = new Set();
  let buffer = '';
  let serial = 0;

  proc.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const space = line.indexOf(' ');
      const kind = line.slice(0, space);
      if (kind !== 'EVT' && kind !== 'LOG') continue;
      let value;
      try {
        value = JSON.parse(line.slice(space + 1));
      } catch {
        continue;
      }
      if (kind === 'LOG') {
        logLines.push(value);
        continue;
      }
      value.seenAt = Date.now();
      events.push(value);
      for (const waiter of [...waiters]) waiter();
    }
  });
  proc.child.once('exit', () => {
    for (const waiter of [...waiters]) waiter();
  });

  const peer = {
    name,
    proc,
    events,
    /** 그 이름의 진단 사건(없으면 전부). 줄마다 at(epoch ms)이 있다. */
    logs: (event) => (event === undefined ? logLines : logLines.filter((line) => line.event === event)),
    /** 조건에 맞는 사건이 나올 때까지 기다려 돌려준다. 이미 나온 것도 본다(from 번째부터). */
    event(match, { timeoutMs = 10_000, what = '사건', from = 0 } = {}) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const finish = (settle, value) => {
          waiters.delete(check);
          if (timer !== null) clearTimeout(timer);
          settle(value);
        };
        const tail = () =>
          `\n--- ${name} 의 마지막 사건 ---\n${events.slice(-8).map((e) => JSON.stringify(e)).join('\n')}\n--- stderr ---\n${proc.stderr().slice(-1500)}`;
        const check = () => {
          const found = events.slice(from).find(match);
          if (found !== undefined) finish(resolve, found);
          else if (proc.exit !== null || !proc.alive()) finish(reject, new Error(`${name}: ${what} 이(가) 나오기 전에 프로세스가 끝났다${tail()}`));
        };
        waiters.add(check);
        timer = setTimeout(() => finish(reject, new Error(`${name}: ${timeoutMs}ms 안에 ${what} 이(가) 나오지 않았다${tail()}`)), timeoutMs);
        check();
      });
    },
    count: (match) => events.filter(match).length,
    /** 명령을 보내고 기다리지 않는다. 돌려준 id 로 나중에 결과를 받는다(result). */
    send(cmd, args = {}) {
      serial += 1;
      const id = serial;
      proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
      return id;
    },
    /** 그 id 의 결과를 기다린다. { at, result } 를 돌려준다. */
    async result(id, { timeoutMs = 45_000, what = `명령 ${id} 의 결과` } = {}) {
      const event = await peer.event((e) => e.t === 'result' && e.id === id, { timeoutMs, what });
      return { at: event.at, result: event.result };
    },
    /** 명령을 보내고 결과를 기다려 돌려준다. */
    async call(cmd, args = {}, options = {}) {
      const id = peer.send(cmd, args);
      return (await peer.result(id, { what: `${cmd} 의 결과`, ...options })).result;
    },
    /** 명령을 보내고 결과와 그 결과가 나온 시각(참가자 프로세스의 시계)을 돌려준다. */
    async timed(cmd, args = {}, options = {}) {
      const id = peer.send(cmd, args);
      return peer.result(id, { what: `${cmd} 의 결과`, ...options });
    },
    /** session.leave 를 부르고 프로세스를 끝낸다. 종료 코드 0 을 확인한다. */
    async leave({ timeoutMs = 10_000 } = {}) {
      if (proc.exit !== null) return proc.exit;
      const left = await peer.call('leave', {}, { timeoutMs });
      proc.stdin.write(`${JSON.stringify({ cmd: 'shutdown', budget: 400 })}\n`);
      const exit = await proc.waitForExit({ timeoutMs });
      if (exit.code !== 0) throw new Error(`${name}: 종료 코드가 ${exit.code}(신호 ${exit.signal}) 다\n${proc.stderr().slice(-1500)}`);
      return { ...exit, left };
    },
    /** 퇴장 없이 종료 절차만 탄다(session.shutdown: presence{left}·bye{shutdown}). */
    async shutdown({ timeoutMs = 10_000, budget = 400 } = {}) {
      if (proc.exit !== null) return proc.exit;
      proc.stdin.write(`${JSON.stringify({ cmd: 'shutdown', budget })}\n`);
      const exit = await proc.waitForExit({ timeoutMs });
      if (exit.code !== 0) throw new Error(`${name}: 종료 코드가 ${exit.code}(신호 ${exit.signal}) 다\n${proc.stderr().slice(-1500)}`);
      return exit;
    },
    /** bye 도 leave 도 없이 죽인다. */
    async kill() {
      proc.killTree('SIGKILL');
      await proc.waitForExit({ timeoutMs: 5_000 }).catch(() => {});
    },
  };
  return peer;
}

/**
 * 서버와 프록시를 띄운다.
 * @param {object} [options]
 * @param {string} [options.label] 프로세스 추적기의 이름.
 * @param {boolean} [options.keepHome] 끝난 뒤 임시 홈(기록 파일)을 지우지 않는다.
 */
export async function startStack(options = {}) {
  const procs = createProcTracker({ label: options.label ?? 'room-e2e' });
  const homeRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-room-e2e-'));
  const peers = [];
  let proxy = null;
  const removeHome = () => {
    if (options.keepHome) return;
    rmSync(homeRoot, { recursive: true, force: true });
  };
  try {
    // 프록시를 거치면 모든 참가자가 127.0.0.1 로 보인다. 주소별 연결 수를 넉넉히 준다.
    const server = procs.spawnDist('entry/server.js', ['--host', '127.0.0.1', '--port', '0', '--max-connections-per-ip', '200'], {
      name: 'server',
      stdin: 'ignore',
    });
    const ready = await server.waitForOutput(/listening on (ws:\/\/\S+)/, { timeoutMs: 10_000 });
    const serverUrl = ready[1];
    proxy = await startSignalProxy({ upstream: serverUrl });

    const stack = {
      procs,
      server,
      proxy,
      serverUrl,
      url: proxy.url,
      homeRoot,
      home: (name) => path.join(homeRoot, name),

      /** 참가자 프로세스를 띄운다. 아직 방에 없다. create·join 은 call 로 부른다. */
      async peer(name, { ice = 'none', url = proxy.url, nodeArgs = [] } = {}) {
        const args = ['--url', url, '--name', name, '--home', path.join(homeRoot, name), '--ice', ice];
        const proc = procs.spawnNode(PEER_SCRIPT, args, {
          name: `peer-${name}`,
          nodeArgs,
          // 참가자 프로세스가 실제 사용자 홈의 설정을 읽지 않게 한다.
          env: { HOME: homeRoot, AGENT_CHAT_HOME: path.join(homeRoot, name) },
        });
        const peer = wrapPeer(proc, name);
        peers.push(peer);
        await peer.event((e) => e.t === 'ready', { what: 'ready', timeoutMs: 15_000 });
        return peer;
      },

      /** 띄운 프로세스의 이름과 pid. 이력에 남길 때 쓴다. */
      pids: () => procs.list(),

      /** 서버와 프록시를 닫고, 띄운 프로세스가 남지 않았는지 확인한다. 남아 있으면 지운 뒤 던진다. */
      async close() {
        for (const peer of peers) {
          if (peer.proc.exit === null) await peer.shutdown().catch(() => peer.kill());
        }
        await proxy.close();
        const stopped = await server.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
        let leftover = null;
        try {
          await procs.assertNoneLeft({ graceMs: 3_000 });
        } catch (error) {
          leftover = error;
        }
        const killed = await procs.dispose();
        removeHome();
        if (leftover !== null) throw leftover;
        if (killed.length > 0) throw new Error(`정리하면서 죽여야 했던 프로세스: ${killed.map((entry) => entry.name).join(', ')}`);
        return { serverExit: stopped };
      },

      /** 실패했을 때의 정리. 남은 프로세스를 모두 지운다. 지운 목록을 돌려준다. */
      async abort() {
        try {
          await proxy.close();
        } catch {
          // 이미 닫혔다.
        }
        const killed = await procs.dispose();
        removeHome();
        return killed;
      },
    };
    return stack;
  } catch (error) {
    if (proxy !== null) await proxy.close().catch(() => {});
    await procs.dispose();
    removeHome();
    throw error;
  }
}
