// 연결 단독 시험의 참가자 프로세스. 제품의 signaling-client 와 mesh 를 손으로 이어 띄운다.
// 조립한 MCP 진입점(src/entry/mcp.ts)과 room-session 에 기대지 않는다. 채팅·공유 상태·P2P 세션(hello)은 없다.
//
// ── 쓰는 법 ─────────────────────────────────────────────────────────────────
//
//   node tests/e2e/mesh/peer.mjs --url <ws 주소> --room <방 ID> --name <이름> --mode create|join
//        [--ice none|<stun: 주소 목록>]   ICE 서버. 기본 none(host 후보만). AGENT_CHAT_ICE_SERVERS 와 같은 형식이다
//        [--sid <12자>] [--key <43자>]    생략하면 새로 만든다
//        [--no-auto-contact]              joined·pong 의 목록에 있는 피어에게 스스로 접촉하지 않는다(명령으로만 접촉)
//        [--recontact]                    링크가 닫히거나 시도가 실패하면 1초 뒤 한 번 다시 접촉한다(목록에 있을 때)
//        [--native-log]                   네이티브 라이브러리(libdatachannel)의 Debug 로그를 NDC 줄로 낸다. 느린 연결의 원인을 볼 때만 쓴다
//
//   빌드 결과는 <저장소>/dist 에서 읽는다. 다른 폴더면 환경 변수 AGENT_CHAT_DIST 로 준다(tests/support/proc.mjs 와 같다).
//
// ── stdout (한 줄에 JSON 하나) ───────────────────────────────────────────────
//
//   EVT {"t":"ready"}                              신호 처리기를 건 뒤. 이 뒤에 SIGTERM 을 보내도 정상 종료한다
//   EVT {"t":"joined","members":[{peer,sid}],"ms":<join 에 걸린 시간>}
//   EVT {"t":"join-failed","code":"…"}             종료 코드 3 으로 끝난다
//   EVT {"t":"state","state":"…","reason":…}       시그널링 상태
//   EVT {"t":"members","source":"joined|pong","members":[…]}
//   EVT {"t":"link-open","peer","sid","cid","at":<epoch ms>}
//   EVT {"t":"link-closed","peer","sid","reason","at"}
//   EVT {"t":"attempt-failed","peer","stage","reason","diag":{…}}
//   EVT {"t":"frame","peer","text"}                ping·pong 을 뺀 받은 프레임
//   EVT {"t":"srflx","at":<epoch ms>}              netInfo().srflx_seen 이 처음 참이 된 때(10ms 마다 본다)
//   EVT {"t":"status","id":<명령의 id>,"links":[…],"net":{…},"signaling":"…","rss":<바이트>,"heap":<바이트>}
//   EVT {"t":"left"}                               leave 명령이나 SIGTERM 으로 정리를 끝냈다. 종료 코드 0
//   LOG {"level","mod","event",…필드}              제품이 남긴 진단 사건(link.attempt_end 의 queued_applied·resends 등)
//   NDC {"at","level","message"}                   (--native-log) 라이브러리 로그. SDP·candidate 가 든 줄은 빼고 주소는 가린다
//
// ── stdin (한 줄에 JSON 하나) ────────────────────────────────────────────────
//
//   {"cmd":"contact","peer":"bob"}        mesh.contact
//   {"cmd":"probe","peer":"bob"}          mesh.probe (교체 확인을 밖에서 시작)
//   {"cmd":"send","peer":"bob","text":"…"}  mesh.send. 결과를 EVT {"t":"sent","peer","result"} 로 낸다
//   {"cmd":"close-link","peer":"bob","reason":"…"}
//   {"cmd":"expire","peer":"bob"}         mesh.expireAttempt
//   {"cmd":"status","id":7}               지금의 링크·netInfo·메모리를 낸다
//   {"cmd":"gc"}                          (node --expose-gc 로 띄웠을 때) 쓰레기 수집을 한 번 돌린다
//   {"cmd":"leave"}                       leave 를 보내고 mesh 를 닫은 뒤 끝난다
//
// SIGTERM·SIGINT 는 leave 명령과 같다. SIGKILL 로 죽이면 bye 없이 사라진 참가자가 된다.
// SDP 와 candidate, 방 ID 는 출력하지 않는다.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const distRoot = process.env.AGENT_CHAT_DIST ? path.resolve(REPO_ROOT, process.env.AGENT_CHAT_DIST) : path.join(REPO_ROOT, 'dist');
const load = (relative) => import(pathToFileURL(path.join(distRoot, relative)).href);

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const out = (kind, value) => process.stdout.write(`${kind} ${JSON.stringify(value)}\n`);
const emit = (value) => out('EVT', value);

const url = argValue('url');
const room = argValue('room');
const name = argValue('name');
const mode = argValue('mode') ?? 'join';
if (!url || !room || !name || !['create', 'join'].includes(mode)) {
  process.stderr.write('사용법: node tests/e2e/mesh/peer.mjs --url <ws 주소> --room <방 ID> --name <이름> --mode create|join [--ice none|<목록>]\n');
  process.exit(2);
}

const protocol = await load('protocol/index.js');
const { createSignalingClient } = await load('signaling-client/index.js');
const { createMesh } = await load('mesh/index.js');
const { LIMITS } = protocol;

const ice = protocol.parseIceServers(argValue('ice') ?? 'none');
if (!ice.ok) {
  process.stderr.write(`ICE 설정을 받지 않는다: ${ice.detail}\n`);
  process.exit(2);
}
const sid = argValue('sid') ?? protocol.newSid();
const key = argValue('key') ?? protocol.newResumeKey();
const autoContact = !hasFlag('no-auto-contact');
const recontact = hasFlag('recontact');

// 전역 시계와 타이머는 조립(여기)에서만 부른다. 모듈에는 주입한다.
const now = () => Date.now();
const timers = { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle) };
const log = { event: (level, mod, event, fields = {}) => out('LOG', { level, mod, event, ...fields }) };

// 라이브러리 로그는 제품이 켜지 않는다. 시험 프로세스가 같은 네이티브 모듈에 직접 건다.
if (hasFlag('native-log')) {
  const native = await import('node-datachannel');
  native.initLogger('Debug', (level, message) => {
    if (/candidate:|a=|v=0|ufrag|pwd|fingerprint/i.test(message)) return;
    // 짧은 꼴(fe80::1, ::1)과 영역 표기(%en0)까지 가린다. 앞뒤가 이름 글자나 콜론이면 주소로 보지 않는다(rtc::impl:: 는 남긴다).
    const masked = message.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip4>').replace(/(?<![\w:])(?:[0-9a-f]{1,4})?(?::[0-9a-f]{0,4}){2,7}(?:%[\w.]+)?(?![\w:])/gi, '<ip6>');
    out('NDC', { at: now(), level, message: masked });
  });
}

const client = createSignalingClient({ url, now, timers, log });

// ── 시그널 문 (room-session 의 signal-gate 가 하는 일을 손으로 한 것) ────────
// joined 전에 받은 offer 로 생긴 answer 와 후보는 들고 있다가 joined 뒤에 보낸다(최대 64건). 그 뒤로는 큐에 쌓지 않는다.
let joined = false;
const heldBeforeJoin = [];
function sendSignal(to, payload) {
  if (joined) return client.sendSignal(to, payload);
  if (heldBeforeJoin.length >= LIMITS.PRE_JOIN_SIGNAL_HOLD_MAX) return false;
  heldBeforeJoin.push([to, payload]);
  return true;
}

const created = await createMesh({
  self: { peer: name, sid },
  iceServers: ice.value,
  sendSignal,
  pingInfo: () => ({ sc: 0, sf: '000000000000' }),
  now,
  timers,
  log,
});
if (!created.ok) {
  emit({ t: 'join-failed', code: created.code });
  process.exit(3);
}
const mesh = created.mesh;

// ── 접촉 (room-session 의 보정을 가장 작게 흉내 낸 것) ───────────────────────
let members = [];
/** 피어 이름 → 링크가 열린 때. 목록의 sid 가 다를 때 교체 확인을 할지 가리는 데 쓴다. */
const openedAt = new Map();

function reconcile(update) {
  members = update.members;
  if (!autoContact) return;
  const links = new Map(mesh.links().map((link) => [link.peer, link]));
  for (const member of members) {
    const link = links.get(member.peer);
    if (link === undefined) mesh.contact(member.peer);
    else if (link.state === 'open' && link.sid !== member.sid && (openedAt.get(member.peer) ?? Infinity) < update.requestedAt) mesh.probe(member.peer);
  }
}

function recontactLater(peer) {
  if (!recontact) return;
  setTimeout(() => {
    if (members.some((member) => member.peer === peer)) mesh.contact(peer);
  }, LIMITS.RECONTACT_DELAY_MS);
}

// 받기는 join 을 보내기 전부터 한다. joined 보다 먼저 온 offer 를 버리지 않는다.
client.on('signal', (signal) => mesh.handleSignal(signal));
client.on('relay-error', (error) => mesh.handleRelayError(error));
client.on('gateway-frame', () => mesh.resendPending());
client.on('members', (update) => {
  emit({ t: 'members', source: update.source, members: update.members });
  reconcile(update);
});
client.on('state', (change) => emit({ t: 'state', state: change.state, reason: change.reason }));

mesh.on('link-open', (link) => {
  openedAt.set(link.peer, now());
  emit({ t: 'link-open', peer: link.peer, sid: link.sid, cid: link.cid, at: now() });
});
mesh.on('link-closed', (link) => {
  openedAt.delete(link.peer);
  emit({ t: 'link-closed', peer: link.peer, sid: link.sid, reason: link.reason, at: now() });
  recontactLater(link.peer);
});
mesh.on('attempt-failed', (failure) => {
  emit({ t: 'attempt-failed', peer: failure.peer, stage: failure.stage, reason: failure.reason, diag: failure.diag });
  if (failure.reason !== 'peer_gone') recontactLater(failure.peer);
});
mesh.on('frame', (frame) => emit({ t: 'frame', peer: frame.peer, text: frame.text }));

// netInfo 는 링크가 열린 뒤에 나온 srflx 후보도 센다. 처음 참이 된 때를 알린다.
const srflxWatch = setInterval(() => {
  if (!mesh.netInfo().srflx_seen) return;
  clearInterval(srflxWatch);
  emit({ t: 'srflx', at: now() });
}, 10);

// ── 끝내기 ──────────────────────────────────────────────────────────────────
let leaving = false;
async function leave(exitCode = 0) {
  if (leaving) return;
  leaving = true;
  clearInterval(srflxWatch);
  rl.close();
  // 부모가 열어 둔 stdin 파이프가 이벤트 루프를 붙잡지 않게 한다. 제품 모듈이 남긴 것이 있으면 그래도 끝나지 않는다.
  process.stdin.unref();
  await client.leave();
  await mesh.shutdown();
  emit({ t: 'left' });
  // pc 를 모두 닫았으면 이벤트 루프가 비어 스스로 끝난다. 남은 것이 있으면 그것이 결함이다.
  process.exitCode = exitCode;
}

// ── 명령 ────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  switch (command?.cmd) {
    case 'contact':
      mesh.contact(command.peer);
      return;
    case 'probe':
      mesh.probe(command.peer);
      return;
    case 'send':
      emit({ t: 'sent', peer: command.peer, result: mesh.send(command.peer, String(command.text)) });
      return;
    case 'close-link':
      mesh.closeLink(command.peer, String(command.reason ?? 'closed_by_test'));
      return;
    case 'expire':
      mesh.expireAttempt(command.peer);
      return;
    case 'status': {
      const memory = process.memoryUsage();
      emit({ t: 'status', id: command.id ?? null, links: mesh.links(), net: mesh.netInfo(), rss: memory.rss, heap: memory.heapUsed });
      return;
    }
    case 'gc':
      globalThis.gc?.();
      return;
    case 'leave':
      void leave(0);
      return;
    default:
  }
});
// 부모가 stdin 을 닫아도(시험 스크립트가 죽어도) 남지 않게 한다.
rl.on('close', () => void leave(0));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void leave(0));
emit({ t: 'ready' });

// ── 입장 ────────────────────────────────────────────────────────────────────
const startedAt = now();
try {
  const result = await client.join({ room, peer: name, sid, key, mode });
  joined = true;
  for (const [to, payload] of heldBeforeJoin.splice(0)) client.sendSignal(to, payload);
  emit({ t: 'joined', members: result.members, ms: now() - startedAt });
  reconcile({ members: result.members, requestedAt: result.requestedAt });
} catch (failure) {
  emit({ t: 'join-failed', code: failure?.code ?? 'UNKNOWN' });
  leaving = true;
  clearInterval(srflxWatch);
  rl.close();
  process.stdin.unref();
  client.close();
  await mesh.shutdown();
  process.exitCode = 3;
}
