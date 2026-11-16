// 방 조율 하네스의 참가자 프로세스. MCP 없이, 제품의 하위 모듈 실물로 room-session 을 세운다.
// 붙이는 것: signaling-client, mesh(node-datachannel), shared-state, inbox, records, room-session.
// 조립한 MCP 진입점(src/entry/mcp.ts)과 mcp-server 에 기대지 않는다. 제품 코드가 아니다.
//
// ── 쓰는 법 ─────────────────────────────────────────────────────────────────
//
//   node tests/e2e/room/peer.mjs --url <ws 주소> --name <이름> --home <임시 AGENT_CHAT_HOME>
//        [--ice none|<stun: 주소 목록>]   ICE 서버. 기본 none(host 후보만). AGENT_CHAT_ICE_SERVERS 와 같은 형식이다
//        [--client <글>]                  presence.client 에 쓸 값. 기본 harness
//
//   --home 은 반드시 준다. 기록 파일이 그 아래에 생긴다. 실제 사용자 홈(~/.agent-chat)을 쓰지 않으려는 것이다.
//   빌드 결과는 <저장소>/dist 에서 읽는다. 다른 폴더면 환경 변수 AGENT_CHAT_DIST 로 준다(tests/support/proc.mjs 와 같다).
//
// ── stdin (한 줄에 JSON 하나. id 를 주면 같은 id 의 result 가 나온다) ─────────
//
//   {"id":1,"cmd":"create","room":"<방 ID>"}            session.create({room_id})
//   {"id":2,"cmd":"join","room":"<방 ID>"}              session.join({room_id})
//   {"id":3,"cmd":"leave"}                              session.leave()
//   {"id":4,"cmd":"send","text":"…","to":["b"],"resend_of":"…"}   session.sendChat
//   {"id":5,"cmd":"command","command":{"type":"start_test",…}}    session.command (SessionCommand 그대로)
//   {"id":6,"cmd":"status"}                             session.status()
//   {"id":7,"cmd":"notice"}                             session.notice()
//   {"id":8,"cmd":"report"}                             session.writeReport()
//   {"id":9,"cmd":"replica"}                            지금 복제본의 경과 시간·지문·기록 식별자(room-session 에 넘긴 shared-state 를 직접 읽는다)
//   {"id":10,"cmd":"inbox"}                             지금까지 수신함에 넣은 사건의 요약(본문 없음)
//   {"cmd":"shutdown","budget":400}                     session.shutdown 뒤 끝난다(SIGTERM·SIGINT 와 같다)
//
// ── stdout (한 줄에 JSON 하나) ───────────────────────────────────────────────
//
//   EVT {"t":"ready"}                                   신호 처리기를 건 뒤
//   EVT {"t":"result","id":…,"cmd":"…","at":<epoch ms>,"result":{…}}   room_id 는 가린다
//   EVT {"t":"signal","kind":"offer","from":"…","at":…}  서버가 준 시그널(joined 전에 온 것을 가려내려고 낸다)
//   EVT {"t":"joined","at":…}                            join 의 답을 받았다
//   EVT {"t":"merged","from":"…","snapshot":true,"at":…,"records":[{"kind","id","author","lc"}]}   복제본을 바꾼 원격 기록
//   EVT {"t":"inbox","at":…,"kind","change","id","from","to","code"}   수신함에 넣은 사건(본문과 data 는 내지 않는다)
//   EVT {"t":"exit","code":0}                            정리를 끝냈다
//   LOG {"level","mod","event",…필드}                    제품이 남긴 진단 사건(state.resync, state.merge, join.end …)
//
// SIGKILL 로 죽이면 bye 없이 사라진 참가자가 된다. SDP, candidate, 방 ID, 채팅 본문은 출력하지 않는다.

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const distRoot = process.env.AGENT_CHAT_DIST ? path.resolve(REPO_ROOT, process.env.AGENT_CHAT_DIST) : path.join(REPO_ROOT, 'dist');
const load = (relative) => import(pathToFileURL(path.join(distRoot, relative)).href);

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

const out = (kind, value) => process.stdout.write(`${kind} ${JSON.stringify(value)}\n`);
const emit = (value) => out('EVT', value);

const url = argValue('url');
const name = argValue('name');
const home = argValue('home');
if (!url || !name || !home) {
  process.stderr.write('사용법: node tests/e2e/room/peer.mjs --url <ws 주소> --name <이름> --home <임시 AGENT_CHAT_HOME> [--ice none|<목록>]\n');
  process.exit(2);
}

const protocol = await load('protocol/index.js');
const { createSignalingClient } = await load('signaling-client/index.js');
const { createMesh } = await load('mesh/index.js');
const { createReplica } = await load('shared-state/index.js');
const { createInbox, DEFAULT_INBOX_LIMITS } = await load('inbox/index.js');
const { openTranscript, writeReport } = await load('records/index.js');
const { createRoomSession, DEFAULT_ROOM_SESSION_LIMITS } = await load('room-session/index.js');

const iceRaw = argValue('ice') ?? 'none';

// 전역 시계와 타이머는 조립(여기)에서만 부른다. 모듈에는 주입한다.
const now = () => Date.now();
const timers = { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle) };
const log = { event: (level, mod, event, fields = {}) => out('LOG', { at: Date.now(), level, mod, event, ...fields }) };

// ── 수신함: 실물에, 넣는 사건의 요약만 밖으로 낸다 ──────────────────────────
const inbox = createInbox({ limits: DEFAULT_INBOX_LIMITS, now, timers, log });
const pushed = [];
const summaryOf = (event) => ({
  kind: event.kind,
  change: event.change,
  id: event.id,
  from: event.from,
  to: event.to,
  code: event.kind === 'system' ? event.data.code : undefined,
  peer: event.kind === 'system' ? event.data.peer : undefined,
});
const observedInbox = {
  push(event) {
    const summary = { at: Date.now(), ...summaryOf(event) };
    pushed.push(summary);
    emit({ t: 'inbox', ...summary });
    inbox.push(event);
  },
  discardAll: () => inbox.discardAll(),
  mode: () => inbox.mode(),
  listening: () => inbox.listening(),
  on: (event, listener) => inbox.on(event, listener),
};

// ── 복제본: 실물을 그대로 넘기고, 병합이 바꾼 기록의 식별자만 밖으로 낸다 ────
/** 가장 최근 입장의 복제본. 경과 시간은 이것의 testElapsed 로 읽는다(verification-plan.md 3.2). */
let replica = null;
const identityOf = (record) => ({
  kind: record.kind,
  id: record.kind === 'presence' || record.kind === 'test' ? record.key : record.rid,
  author: record.author,
  lc: record.lc,
});
const observedCreateReplica = (deps) => {
  const real = createReplica(deps);
  replica = real;
  return {
    applyLocal: (command, at) => real.applyLocal(command, at),
    mergeRemote(records, origin, at) {
      const merged = real.mergeRemote(records, origin, at);
      if (merged.applied.length > 0) {
        emit({ t: 'merged', from: origin.from, snapshot: origin.snapshot, at: Date.now(), records: merged.applied.map(identityOf) });
      }
      return merged;
    },
    snapshot: () => real.snapshot(),
    view: (at) => real.view(at),
    fingerprint: () => real.fingerprint(),
    testElapsed: (at) => real.testElapsed(at),
    adoptElapsed: (testId, ms, at) => real.adoptElapsed(testId, ms, at),
  };
};

// ── 시그널링 클라이언트: 실물에, 서버가 준 시그널의 종류와 joined 시각만 밖으로 낸다 ─
const observedCreateSignalingClient = (deps) => {
  const client = createSignalingClient(deps);
  client.on('signal', (signal) => emit({ t: 'signal', kind: signal.kind, from: signal.from, at: Date.now() }));
  return {
    on: (event, listener) => client.on(event, listener),
    join: (request) =>
      client.join(request).then((joined) => {
        emit({ t: 'joined', at: Date.now(), members: joined.members.map((member) => member.peer) });
        return joined;
      }),
    sendSignal: (to, payload) => client.sendSignal(to, payload),
    leave: () => client.leave(),
    close: () => client.close(),
  };
};

const session = createRoomSession({
  config: {
    defaultServer: url,
    name,
    client: argValue('client') ?? 'harness',
    iceServers: { raw: iceRaw, parsed: protocol.parseIceServers(iceRaw) },
    home,
  },
  app: { name: 'agent-chat', version: '0.0.0-harness' },
  limits: DEFAULT_ROOM_SESSION_LIMITS,
  inbox: observedInbox,
  createSignalingClient: observedCreateSignalingClient,
  createMesh,
  createReplica: observedCreateReplica,
  openTranscript,
  writeReport,
  now,
  timers,
  log,
});

/** 결과에서 방 ID 를 가린다. 방 ID 는 접근 수단이라 출력에 남기지 않는다. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'room_id' ? '(가림)' : redact(item)]));
}

function replicaInfo() {
  if (replica === null) return { present: false };
  const at = Date.now();
  const records = replica.snapshot();
  const view = replica.view(at);
  return {
    present: true,
    at,
    elapsed_ms: replica.testElapsed(at),
    fingerprint: replica.fingerprint(),
    count: records.length,
    test_id: view.test?.test_id ?? null,
    stopped: view.test?.stopped === null || view.test === null ? null : { reason: view.test.stopped.reason, by: view.test.stopped.by },
    ids: records.map((record) => identityOf(record).id),
    presences: Object.fromEntries(view.presences.map((presence) => [presence.peer, { status: presence.status, note: presence.note, lc: presence.lc }])),
  };
}

let exiting = false;
async function finish(budgetMs) {
  if (exiting) return;
  exiting = true;
  await session.shutdown(budgetMs);
  inbox.close();
  emit({ t: 'exit', code: 0 });
  // 남은 출력이 나간 뒤에 끝낸다.
  process.stdout.write('', () => process.exit(0));
}

async function run(message) {
  switch (message.cmd) {
    case 'create':
      return session.create({ room_id: message.room, ...(message.server ? { server: message.server } : {}) });
    case 'join':
      return session.join({ room_id: message.room, ...(message.server ? { server: message.server } : {}) });
    case 'leave':
      return session.leave();
    case 'send':
      return session.sendChat({
        text: message.text ?? '',
        ...(message.to ? { to: message.to } : {}),
        ...(message.resend_of ? { resend_of: message.resend_of } : {}),
      });
    case 'command':
      return session.command(message.command);
    case 'status':
      return session.status();
    case 'notice':
      return session.notice();
    case 'report':
      return session.writeReport();
    case 'replica':
      return replicaInfo();
    case 'inbox':
      return { events: pushed };
    default:
      return { ok: false, code: 'UNKNOWN_COMMAND' };
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.cmd === 'shutdown') {
    void finish(Number.isFinite(message.budget) ? message.budget : 400);
    return;
  }
  void run(message).then(
    (result) => emit({ t: 'result', id: message.id, cmd: message.cmd, at: Date.now(), result: redact(result) }),
    (error) => emit({ t: 'result', id: message.id, cmd: message.cmd, at: Date.now(), result: { ok: false, code: 'THROWN', detail: String(error?.name ?? 'Error') } }),
  );
});
// 부모가 사라지면 stdin 이 닫힌다. 고아로 남지 않는다.
lines.on('close', () => void finish(400));

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void finish(400));
emit({ t: 'ready' });
