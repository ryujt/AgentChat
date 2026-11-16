// 연결 단독 시험(V-L11)의 하네스. 자체 호스팅 서버, 시험용 프록시, 참가자 프로세스(peer.mjs)를 띄우고 다룬다.
// 제품 코드가 아니다. 참가자 프로세스 안에서만 제품의 signaling-client 와 mesh 가 돈다.
//
// ── 쓰는 법 (시나리오 스크립트 안에서) ───────────────────────────────────────
//
//   import { startStack, newRoomId } from './harness.mjs';
//
//   const stack = await startStack({ label: 'v-l11' });      // 서버(빈 포트) + 프록시(빈 포트)
//   const room = newRoomId();
//   const alice = await stack.peer({ room, name: 'alice', mode: 'create' });   // joined 까지 기다린다
//   const bob = await stack.peer({ room, name: 'bob', mode: 'join' });
//   await bob.linkOpen('alice');                 // link-open 사건을 기다려 돌려준다
//   alice.command({ cmd: 'send', peer: 'bob', text: 'hi' });
//   await bob.event((e) => e.t === 'frame' && e.text === 'hi');
//   const end = bob.logs('link.attempt_end').at(-1);   // 제품이 남긴 진단 사건(queued_applied, resends …)
//   stack.proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', nth: 1, op: 'drop' });   // tests/support/signal-proxy.mjs
//   await alice.leave();                          // leave 명령 → 종료 코드 0 을 확인한다
//   await stack.close();                          // 남은 프로세스가 있으면 던진다
//
//   stack.url        참가자에게 줄 주소(프록시).   stack.serverUrl   서버에 바로 붙는 주소(프록시를 건너뛴다)
//   stack.raw(url)   제품 코드를 쓰지 않는 날 ws 클라이언트. 같은 이름의 다른 프로세스 노릇을 할 때 쓴다
//
// 빌드 결과는 <저장소>/dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 준다(예: AGENT_CHAT_DIST=.work/w3a/dist).
// 포트는 모두 0(빈 포트)이다. 고정 포트를 쓰지 않는다.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import WebSocket from 'ws';
import { REPO_ROOT, createProcTracker, delay } from '../../support/proc.mjs';
import { startSignalProxy } from '../../support/signal-proxy.mjs';

const PEER_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'mesh', 'peer.mjs');
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomAlnum(length) {
  let text = '';
  for (const byte of randomBytes(length * 2)) {
    if (byte >= 252) continue;
    text += ALNUM[byte % 36];
    if (text.length === length) break;
  }
  return text.padEnd(length, '0');
}

/** 무작위 방 ID(16자). 기록과 출력에 남기지 않는다. */
export function newRoomId() {
  return randomAlnum(16);
}

export function newSid() {
  return randomAlnum(12);
}

export function newKey() {
  return randomBytes(32).toString('base64url');
}

export { delay };

/** 조건이 참이 될 때까지 기다린다. 기한을 넘기면 던진다. */
export async function until(condition, what, timeoutMs = 10_000, pollMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`);
    await delay(pollMs);
  }
}

/** 참가자 프로세스 하나를 감싼다. stdout 의 EVT·LOG 줄을 읽어 모은다. */
function wrapPeer(proc, name) {
  const events = [];
  const logLines = [];
  const nativeLines = [];
  const waiters = new Set();
  let buffer = '';

  proc.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const space = line.indexOf(' ');
      const kind = line.slice(0, space);
      if (kind !== 'EVT' && kind !== 'LOG' && kind !== 'NDC') continue;
      let value;
      try {
        value = JSON.parse(line.slice(space + 1));
      } catch {
        continue;
      }
      if (kind === 'LOG') {
        // 제품의 진단 사건에는 시각이 없다. 사건의 순서와 간격을 보려고 받은 때를 붙인다.
        value.seenAt = Date.now();
        logLines.push(value);
        continue;
      }
      if (kind === 'NDC') {
        nativeLines.push(value);
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
    /** 그 이름의 진단 사건(없으면 전부). */
    logs: (event) => (event === undefined ? logLines : logLines.filter((line) => line.event === event)),
    /** 라이브러리 로그(참가자를 --native-log 로 띄웠을 때만 찬다). */
    nativeLogs: () => nativeLines,
    /** 조건에 맞는 사건이 나올 때까지 기다려 돌려준다. 이미 나온 것도 본다(from 번째부터). */
    event(match, { timeoutMs = 10_000, what = '사건', from = 0 } = {}) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const finish = (settle, value) => {
          waiters.delete(check);
          if (timer !== null) clearTimeout(timer);
          settle(value);
        };
        const tail = () => `\n--- ${name} 의 마지막 사건 ---\n${events.slice(-8).map((e) => JSON.stringify(e)).join('\n')}\n--- stderr ---\n${proc.stderr().slice(-1500)}`;
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
    command(command) {
      proc.stdin.write(`${JSON.stringify(command)}\n`);
    },
    linkOpen: (remote, options = {}) => peer.event((e) => e.t === 'link-open' && e.peer === remote, { what: `${remote} 와의 link-open`, timeoutMs: 20_000, ...options }),
    linkClosed: (remote, options = {}) => peer.event((e) => e.t === 'link-closed' && e.peer === remote, { what: `${remote} 와의 link-closed`, ...options }),
    /** 지금의 링크·netInfo·메모리. gc 가 참이면 먼저 쓰레기 수집을 돌린다(--expose-gc 로 띄웠을 때). */
    async status({ gc = false } = {}) {
      const id = `${Date.now().toString(36)}${randomAlnum(4)}`;
      if (gc) {
        peer.command({ cmd: 'gc' });
        await delay(50);
      }
      peer.command({ cmd: 'status', id });
      return peer.event((e) => e.t === 'status' && e.id === id, { what: 'status' });
    },
    /** leave 명령을 보내고 종료 코드 0 으로 끝나기를 기다린다. */
    async leave({ timeoutMs = 5_000 } = {}) {
      if (proc.exit !== null) return proc.exit;
      peer.command({ cmd: 'leave' });
      const exit = await proc.waitForExit({ timeoutMs });
      if (exit.code !== 0) throw new Error(`${name}: leave 뒤 종료 코드가 ${exit.code}(신호 ${exit.signal}) 다\n${proc.stderr().slice(-1500)}`);
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

/** 제품 코드를 쓰지 않는 날 클라이언트. ws 와 JSON 만 쓴다. */
async function openRaw(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  const received = [];
  const waiters = new Set();
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      received.push(JSON.parse(data.toString('utf8')));
    } catch {
      return;
    }
    for (const waiter of [...waiters]) waiter();
  });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let serial = 0;
  const raw = {
    received,
    send(message) {
      serial += 1;
      const id = `r${serial.toString(36)}`;
      socket.send(JSON.stringify({ id, ...message }));
      return id;
    },
    reply(id, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = received.find((message) => message.re === id);
          if (found === undefined) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`날 클라이언트: ${timeoutMs}ms 안에 응답이 없다`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    /** join 을 보내고 응답(joined 또는 error)을 돌려준다. */
    async join({ room, peer, sid = newSid(), key = newKey(), mode = 'join', seq = 1 }) {
      const id = raw.send({ action: 'join', v: 1, room, peer, sid, key, mode, seq });
      const reply = await raw.reply(id);
      return { reply, sid };
    },
    signal: (to, payload) => raw.send({ action: 'signal', to, ...payload }),
    close() {
      try {
        socket.terminate();
      } catch {
        // 이미 닫혔다.
      }
    },
  };
  return raw;
}

/**
 * 서버와 프록시를 띄운다.
 * @param {object} [options]
 * @param {string} [options.label] 프로세스 추적기의 이름.
 * @param {number} [options.maxConnectionsPerIp] 서버의 주소별 연결 수. 프록시를 거치면 모두 127.0.0.1 이라 기본값(20)보다 넉넉히 준다.
 */
export async function startStack(options = {}) {
  const procs = createProcTracker({ label: options.label ?? 'mesh-e2e' });
  const raws = new Set();
  let proxy = null;
  try {
    const server = procs.spawnDist('entry/server.js', ['--host', '127.0.0.1', '--port', '0', '--max-connections-per-ip', String(options.maxConnectionsPerIp ?? 200)], {
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

      /** 참가자 프로세스를 띄운다. wait 가 'joined'(기본)면 입장까지 기다린다. 'ready' 면 띄우기만 한다. */
      async peer({ room, name, mode, ice = 'none', url = proxy.url, wait = 'joined', flags = [], nodeArgs = [], sid }) {
        const args = ['--url', url, '--room', room, '--name', name, '--mode', mode, '--ice', ice, ...(sid ? ['--sid', sid] : []), ...flags];
        const proc = procs.spawnNode(PEER_SCRIPT, args, { name: `peer-${name}`, nodeArgs });
        const peer = wrapPeer(proc, name);
        await peer.event((e) => e.t === 'ready', { what: 'ready', timeoutMs: 15_000 });
        if (wait === 'joined') {
          const outcome = await peer.event((e) => e.t === 'joined' || e.t === 'join-failed', { what: 'joined', timeoutMs: 25_000 });
          if (outcome.t !== 'joined') throw new Error(`${name}: 입장하지 못했다(${outcome.code})`);
        }
        return peer;
      },

      async raw(url = serverUrl) {
        const raw = await openRaw(url);
        raws.add(raw);
        return raw;
      },

      /** 서버와 프록시를 닫고, 띄운 프로세스가 남지 않았는지 확인한다. 남아 있으면 지운 뒤 던진다. */
      async close() {
        for (const raw of raws) raw.close();
        await proxy.close();
        const stopped = await server.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
        let leftover = null;
        try {
          await procs.assertNoneLeft({ graceMs: 3_000 });
        } catch (error) {
          leftover = error;
        }
        const killed = await procs.dispose();
        if (leftover !== null) throw leftover;
        if (killed.length > 0) throw new Error(`정리하면서 죽여야 했던 프로세스: ${killed.map((entry) => entry.name).join(', ')}`);
        return { serverExit: stopped, serverStderr: server.stderr() };
      },

      /** 실패했을 때의 정리. 남은 프로세스를 모두 지운다. 지운 목록을 돌려준다. */
      async abort() {
        for (const raw of raws) raw.close();
        await proxy.close().catch(() => {});
        return procs.dispose();
      },
    };
    return stack;
  } catch (error) {
    await proxy?.close().catch(() => {});
    await procs.dispose();
    throw error;
  }
}
