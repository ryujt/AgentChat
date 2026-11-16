// 시험용 시그널링 프록시. 제품 코드가 아니다. src 는 이 파일을 import 하지 않는다.
// 클라이언트와 자체 호스팅 서버 사이에 서서, 지정한 쌍·종류·순번의 메시지를 버리거나 늦춘다.
// 시그널의 유실·순서 뒤바뀜·지연을 제품 코드의 분기 없이 만들기 위한 도구다(verification-plan.md 3.2).
// ws 와 JSON 만 쓴다. protocol 스키마도 제품 클라이언트도 쓰지 않는다. 그래서 잘못된 프레임도 그대로 지나간다.
//
// ── 쓰는 법 (시험 스크립트 안에서) ───────────────────────────────────────────
//
//   import { startSignalProxy } from '../support/signal-proxy.mjs';
//
//   const proxy = await startSignalProxy({ upstream: 'ws://127.0.0.1:8787' });   // port 생략 → 빈 포트
//   // 클라이언트(MCP 프로세스, mesh 하네스)에는 서버 주소 대신 proxy.url 을 준다.
//
//   // alice 가 bob 에게 보내는 offer 를 첫 번째 것만 버린다.
//   const rule = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', nth: 1, op: 'drop' });
//   // alice 와 bob 사이의 후보를 양방향 모두, 계속 버린다("직접 연결 불가"는 양방향을 버려야 만들어진다).
//   proxy.addRule({ pair: ['alice', 'bob'], kind: 'candidate', op: 'drop' });
//   // bob 이 받는 joined 를 500ms 늦춘다(offer 가 joined 보다 먼저 오게).
//   proxy.addRule({ dir: 's2c', type: 'joined', to: 'bob', op: 'delay', delayMs: 500 });
//   // 붙들어 두었다가 원하는 때에 놓는다(순서를 확실히 뒤집을 때).
//   const held = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', op: 'hold' });
//   …; held.release();
//
//   rule.hits            // 이 규칙이 실제로 적용한 횟수. 주입이 일어났다는 증거로 쓴다.
//   rule.remove();       // 규칙 하나 지우기.   proxy.clearRules();  // 전부 지우기(붙든 것은 놓는다)
//   proxy.disconnect({ peer: 'alice' });   // 서버 쪽에서 소켓이 끊긴 것처럼 alice 의 연결을 끊는다(생략하면 전부)
//   proxy.block('alice'); proxy.unblock('alice');   // 막힌 동안 alice 의 join 은 서버에 닿지 않고 끊긴다(시그널링만 끊긴 상태)
//   proxy.stats();       // 지나간 프레임 수, 쌍별·종류별 signal 수, 가장 큰 signal 의 바이트 수, 버린·늦춘 건수
//   proxy.events;        // 규칙이 적용된 기록(본문 없음). {at, rule, op, dir, from, to, what, kind, nth}
//   await proxy.close();
//
// ── 규칙 ────────────────────────────────────────────────────────────────────
//
//   dir      'c2s'(기본. 클라이언트 → 서버) | 's2c'(서버 → 클라이언트)
//            signal 을 버릴 때는 보통 'c2s' 에서 버린다. 서버에 닿지 않으므로 보낸 쪽이 오류를 받지 않는다.
//            's2c' 에서 버리면 서버는 전달했다고 보지만 받는 쪽에 도착하지 않는다.
//   action   'c2s' 에서 견줄 action: 'join' | 'signal' | 'ping' | 'leave'. kind 를 주면 'signal' 로 본다.
//   type     's2c' 에서 견줄 type: 'joined' | 'signal' | 'pong' | 'error'. kind 를 주면 'signal' 로 본다.
//   kind     signal 의 종류: 'offer-request' | 'offer' | 'answer' | 'candidate'
//   code     's2c' 의 error.code
//   from     보낸 참가자 이름. 'c2s' 에서는 그 연결이 join 에 쓴 이름, 's2c' 의 signal 에서는 메시지의 from.
//   to       받는 참가자 이름. 'c2s' 의 signal 에서는 메시지의 to, 's2c' 에서는 그 연결이 join 에 쓴 이름.
//   pair     [a, b]. from·to 가 이 둘이면(어느 방향이든) 맞는다.
//   match    (message, {dir, from, to}) => boolean. 위 조건을 모두 지난 뒤에 더 거른다.
//   nth      조건에 맞은 메시지 가운데 몇 번째에 적용할지(1부터). 수 | 수의 배열 | {first, last} | (n) => boolean.
//            생략하면 전부다. 순번은 규칙마다 따로 센다.
//   op       'drop'(버린다) | 'delay'(delayMs 뒤에 보낸다. 그 사이의 메시지가 앞질러 간다) |
//            'hold'(release() 를 부를 때까지 붙든다) | 'duplicate'(두 번 보낸다)
//   delayMs  'delay' 의 지연(ms)
//
//   규칙은 더한 순서대로 본다. 한 메시지에는 처음 적용된 규칙 하나만 적용된다.
//   참가자 이름은 그 연결이 보낸 join 에서 배운다. join 전의 프레임에는 이름이 없다(from·to 조건에 맞지 않는다).
//
// ── 혼자 띄우기 (손으로 확인할 때) ───────────────────────────────────────────
//
//   node tests/support/signal-proxy.mjs --upstream ws://127.0.0.1:8787 [--port 0] [--rules '<JSON 배열>']
//   준비되면 stdout 에 `signal-proxy listening on ws://127.0.0.1:<포트>` 를 쓴다. SIGTERM·SIGINT 로 끝낸다.
//   (--rules 에는 match 와 함수 꼴의 nth 를 쓸 수 없다.)
//
// 본문(SDP, candidate, 방 ID)은 기록하지 않는다. events 와 stats 에는 이름·종류·순번·크기만 남는다.

import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const OPS = ['drop', 'delay', 'hold', 'duplicate'];
const DIRS = ['c2s', 's2c'];
const RULE_KEYS = ['dir', 'action', 'type', 'kind', 'code', 'from', 'to', 'pair', 'match', 'nth', 'op', 'delayMs'];
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function normalizeRule(input) {
  if (typeof input !== 'object' || input === null) throw new TypeError('규칙은 객체여야 한다');
  for (const key of Object.keys(input)) {
    if (!RULE_KEYS.includes(key)) throw new TypeError(`모르는 규칙 항목이다: ${key}`);
  }
  const rule = { dir: 'c2s', ...input };
  if (!DIRS.includes(rule.dir)) throw new TypeError(`dir 는 ${DIRS.join(' 또는 ')} 다: ${rule.dir}`);
  if (!OPS.includes(rule.op)) throw new TypeError(`op 는 ${OPS.join(', ')} 가운데 하나다: ${rule.op}`);
  if (rule.op === 'delay' && !(Number.isFinite(rule.delayMs) && rule.delayMs >= 0)) throw new TypeError('delay 에는 0 이상의 delayMs 를 준다');
  if (rule.dir === 'c2s' && rule.type !== undefined) throw new TypeError("type 은 dir: 's2c' 에서만 쓴다");
  if (rule.dir === 's2c' && rule.action !== undefined) throw new TypeError("action 은 dir: 'c2s' 에서만 쓴다");
  if (rule.code !== undefined && rule.dir !== 's2c') throw new TypeError("code 는 dir: 's2c' 에서만 쓴다");
  if (rule.pair !== undefined && !(Array.isArray(rule.pair) && rule.pair.length === 2)) throw new TypeError('pair 는 이름 두 개의 배열이다');
  if (rule.match !== undefined && typeof rule.match !== 'function') throw new TypeError('match 는 함수다');
  const nth = rule.nth;
  const nthOk =
    nth === undefined ||
    typeof nth === 'function' ||
    (Number.isInteger(nth) && nth >= 1) ||
    (Array.isArray(nth) && nth.every((n) => Number.isInteger(n) && n >= 1)) ||
    (typeof nth === 'object' && nth !== null && !Array.isArray(nth) && (nth.first === undefined || Number.isInteger(nth.first)) && (nth.last === undefined || Number.isInteger(nth.last)));
  if (!nthOk) throw new TypeError('nth 는 1 이상의 수, 수의 배열, {first, last}, 함수 가운데 하나다');
  // kind 는 signal 에만 있다.
  if (rule.kind !== undefined) {
    if (rule.dir === 'c2s') rule.action ??= 'signal';
    else rule.type ??= 'signal';
  }
  return rule;
}

function selects(nth, n) {
  if (nth === undefined) return true;
  if (typeof nth === 'function') return nth(n) === true;
  if (typeof nth === 'number') return n === nth;
  if (Array.isArray(nth)) return nth.includes(n);
  return n >= (nth.first ?? 1) && n <= (nth.last ?? Infinity);
}

/**
 * 프록시를 띄운다.
 *
 * @param {object} options
 * @param {string} options.upstream 자체 호스팅 서버의 주소(ws://…).
 * @param {string} [options.host] 바인드 주소. 기본 127.0.0.1.
 * @param {number} [options.port] 기본 0(빈 포트).
 * @param {object[]} [options.rules] 처음부터 걸어 둘 규칙.
 */
export async function startSignalProxy(options) {
  if (typeof options?.upstream !== 'string' || !/^wss?:\/\//.test(options.upstream)) throw new TypeError('upstream 에 ws:// 주소를 준다');
  const host = options.host ?? '127.0.0.1';
  /** @type {{id: number, rule: object, seen: number, hits: number, held: (() => void)[], removed: boolean}[]} */
  const rules = [];
  const links = new Set();
  const blocked = new Set();
  const timers = new Set();
  const events = [];
  const counters = {
    frames: { c2s: 0, s2c: 0 },
    /** `${from}>${to}:${kind}` → 클라이언트가 보낸 signal 수(버린 것 포함). */
    signals: new Map(),
    maxSignalBytes: 0,
    dropped: 0,
    delayed: 0,
    held: 0,
    duplicated: 0,
    connections: 0,
    blockedJoins: 0,
  };
  let ruleSerial = 0;
  let closed = false;

  const server = new WebSocketServer({ host, port: options.port ?? 0, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;

  function later(ms, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  function closeLink(link, how = 'terminate') {
    if (link.closed) return;
    link.closed = true;
    links.delete(link);
    for (const socket of [link.client, link.upstream]) {
      try {
        if (how === 'terminate' || socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1000);
      } catch {
        // 이미 닫힌 소켓이다.
      }
    }
  }

  /** 프레임을 받는 쪽으로 보낸다. 닫힌 쪽이면 버린다. */
  function forward(link, dir, data, isBinary) {
    const target = dir === 'c2s' ? link.upstream : link.client;
    if (dir === 'c2s' && target.readyState === WebSocket.CONNECTING) {
      link.pending.push([data, isBinary]);
      return;
    }
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
  }

  function matches(rule, dir, message, link) {
    if (rule.dir !== dir) return null;
    const what = dir === 'c2s' ? message.action : message.type;
    if (dir === 'c2s' && rule.action !== undefined && rule.action !== what) return null;
    if (dir === 's2c' && rule.type !== undefined && rule.type !== what) return null;
    if (rule.kind !== undefined && rule.kind !== message.kind) return null;
    if (rule.code !== undefined && rule.code !== message.code) return null;
    const from = dir === 'c2s' ? link.peer : typeof message.from === 'string' ? message.from : null;
    const to = dir === 'c2s' ? (typeof message.to === 'string' ? message.to : null) : link.peer;
    if (rule.from !== undefined && rule.from !== from) return null;
    if (rule.to !== undefined && rule.to !== to) return null;
    if (rule.pair !== undefined) {
      const [a, b] = rule.pair;
      if (!((from === a && to === b) || (from === b && to === a))) return null;
    }
    if (rule.match !== undefined && rule.match(message, { dir, from, to }) !== true) return null;
    return { what, from, to };
  }

  function handleFrame(link, dir, data, isBinary) {
    counters.frames[dir] += 1;
    let message = null;
    if (!isBinary) {
      try {
        const parsed = JSON.parse(data.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) message = parsed;
      } catch {
        // JSON 이 아닌 프레임은 규칙 없이 그대로 지나간다.
      }
    }
    if (message === null) {
      forward(link, dir, data, isBinary);
      return;
    }

    if (dir === 'c2s' && message.action === 'join' && typeof message.peer === 'string') {
      link.peer = message.peer;
      if (blocked.has(message.peer)) {
        counters.blockedJoins += 1;
        events.push({ at: Date.now(), rule: null, op: 'block', dir, from: message.peer, to: null, what: 'join', kind: null, nth: counters.blockedJoins });
        closeLink(link);
        return;
      }
    }
    if (dir === 'c2s' && message.action === 'signal' && typeof message.kind === 'string') {
      const key = `${link.peer ?? '?'}>${typeof message.to === 'string' ? message.to : '?'}:${message.kind}`;
      counters.signals.set(key, (counters.signals.get(key) ?? 0) + 1);
      counters.maxSignalBytes = Math.max(counters.maxSignalBytes, data.length);
    }

    for (const entry of rules) {
      if (entry.removed) continue;
      const hit = matches(entry.rule, dir, message, link);
      if (hit === null) continue;
      entry.seen += 1;
      if (!selects(entry.rule.nth, entry.seen)) continue;
      entry.hits += 1;
      events.push({ at: Date.now(), rule: entry.id, op: entry.rule.op, dir, from: hit.from, to: hit.to, what: hit.what ?? null, kind: message.kind ?? null, nth: entry.seen });
      switch (entry.rule.op) {
        case 'drop':
          counters.dropped += 1;
          return;
        case 'delay':
          counters.delayed += 1;
          later(entry.rule.delayMs, () => forward(link, dir, data, isBinary));
          return;
        case 'hold':
          counters.held += 1;
          entry.held.push(() => forward(link, dir, data, isBinary));
          return;
        case 'duplicate':
          counters.duplicated += 1;
          forward(link, dir, data, isBinary);
          forward(link, dir, data, isBinary);
          return;
      }
    }
    forward(link, dir, data, isBinary);
  }

  server.on('connection', (client) => {
    counters.connections += 1;
    // 서버는 Origin 이 있는 핸드셰이크를 거절한다. ws 클라이언트는 Origin 을 보내지 않는다.
    const upstream = new WebSocket(options.upstream, { perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
    const link = { client, upstream, peer: null, pending: [], closed: false };
    links.add(link);

    upstream.on('open', () => {
      for (const [data, isBinary] of link.pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    client.on('message', (data, isBinary) => handleFrame(link, 'c2s', data, isBinary));
    upstream.on('message', (data, isBinary) => handleFrame(link, 's2c', data, isBinary));
    // 한쪽이 닫히면 다른 쪽도 닫는다. 서버가 닫은 것은 닫기 핸드셰이크로, 끊긴 것은 끊김으로 넘긴다.
    client.on('close', () => closeLink(link, 'close'));
    upstream.on('close', (code) => closeLink(link, code === 1006 ? 'terminate' : 'close'));
    client.on('error', () => closeLink(link));
    upstream.on('error', () => closeLink(link));
  });

  function release(entry) {
    for (const send of entry.held.splice(0)) send();
  }

  const proxy = {
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${port}`,
    host,
    port,
    upstream: options.upstream,
    events,

    /** 규칙을 더하고 손잡이를 돌려준다. */
    addRule(input) {
      if (closed) throw new Error('닫힌 프록시에는 규칙을 더할 수 없다');
      ruleSerial += 1;
      const entry = { id: ruleSerial, rule: normalizeRule(input), seen: 0, hits: 0, held: [], removed: false };
      rules.push(entry);
      return {
        id: entry.id,
        /** 조건에 맞은 메시지 수(순번이 맞지 않아 지나간 것 포함). */
        get seen() {
          return entry.seen;
        },
        /** 실제로 적용한 횟수. */
        get hits() {
          return entry.hits;
        },
        /** 붙들고 있는 메시지 수('hold'). */
        get holding() {
          return entry.held.length;
        },
        /** 붙든 메시지를 받은 순서대로 보낸다. 놓은 수를 돌려준다. */
        release() {
          const count = entry.held.length;
          release(entry);
          return count;
        },
        /** 규칙을 지운다. 붙든 메시지는 놓는다. */
        remove() {
          entry.removed = true;
          release(entry);
          const index = rules.indexOf(entry);
          if (index >= 0) rules.splice(index, 1);
        },
      };
    },

    clearRules() {
      for (const entry of rules.splice(0)) {
        entry.removed = true;
        release(entry);
      }
    },

    /** 서버 쪽에서 소켓이 끊긴 것처럼 연결을 끊는다. peer 를 주면 그 참가자의 연결만. 끊은 수를 돌려준다. */
    disconnect({ peer } = {}) {
      const targets = [...links].filter((link) => peer === undefined || link.peer === peer);
      for (const link of targets) closeLink(link);
      return targets.length;
    },

    /** 그 참가자의 시그널링을 막는다. 열린 연결을 끊고, 막힌 동안의 join 은 서버에 닿기 전에 끊는다. */
    block(peer) {
      blocked.add(peer);
      return proxy.disconnect({ peer });
    },

    unblock(peer) {
      blocked.delete(peer);
    },

    /** 지금 열려 있는 연결의 참가자 이름(join 전이면 null). */
    connections() {
      return [...links].map((link) => link.peer);
    },

    stats() {
      return {
        frames: { ...counters.frames },
        signals: Object.fromEntries(counters.signals),
        maxSignalBytes: counters.maxSignalBytes,
        dropped: counters.dropped,
        delayed: counters.delayed,
        held: counters.held,
        duplicated: counters.duplicated,
        connections: counters.connections,
        blockedJoins: counters.blockedJoins,
        open: links.size,
      };
    },

    /** 모든 연결을 끊고 리스너를 닫는다. 늦추거나 붙든 메시지는 버린다. */
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const entry of rules.splice(0)) {
        entry.removed = true;
        entry.held.length = 0;
      }
      for (const link of [...links]) closeLink(link);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  for (const rule of options.rules ?? []) proxy.addRule(rule);
  return proxy;
}

// ── 혼자 띄우기 ─────────────────────────────────────────────────────────────

async function main(argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index < 0 ? undefined : argv[index + 1];
  };
  const upstream = value('upstream');
  if (!upstream) {
    process.stderr.write("사용법: node tests/support/signal-proxy.mjs --upstream ws://127.0.0.1:8787 [--port 0] [--rules '<JSON 배열>']\n");
    process.exitCode = 2;
    return;
  }
  const proxy = await startSignalProxy({
    upstream,
    port: Number.parseInt(value('port') ?? '0', 10),
    rules: value('rules') === undefined ? [] : JSON.parse(value('rules')),
  });
  const stop = () => {
    void proxy.close().then(() => {
      process.stdout.write(`${JSON.stringify(proxy.stats())}\n`);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.write(`signal-proxy listening on ${proxy.url}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
