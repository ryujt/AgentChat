#!/usr/bin/env node
// V-P8 공용 서버를 거친 관전 (verification-plan.md 3.3, architecture.md 3.14·S16). 제품 코드가 아니다. 짧은 실제 확인이다.
// 서버 인자 없이(공용 서버) 조립한 MCP 프로세스 2개가 방을 만들고 들어간다. 관전 프로세스를 --server 없이 띄운다:
// (가) node dist/entry/monitor.js --json, (나) sh scripts/monitor.sh 의 사람용 출력.
// 통과: 25초 안에 snapshot(참가자 2명). 두 MCP 의 get_status.observers 에 관전자. 방 전체 글 2건이 각 10초 안에 관전 출력에 한 번씩,
// 대상 지정 글 1건은 0번. SIGINT 뒤 3초 안에 종료 코드 0, 두 MCP 가 observer_left 를 받는다, 남은 프로세스 0. 끝나고 두 MCP 도 leave_room.
// 공용 서버를 정상 사용 수준으로만 쓴다: 전체 2분 이내, 글 3건(+사람용 확인 1건), 관전 입장 2회. 같은 PC 라 NAT 통과는 확인되지 않는다.
//
// 실행: node tests/e2e/public/v-p8-monitor.mjs [--out <스크래치 폴더>]
// --out 을 주면 관전 출력 표본(사람용, JSON)을 그 폴더에 남긴다. 방 ID 는 출력에 없다. 명령 줄의 방 ID 는 <room_id> 로 가린다.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, distPath } from '../../support/proc.mjs';
import { argValue, createReport, delay, finish, isPidAlive, newRoomId, PUBLIC_SERVER, startStack, until } from '../scenarios/harness.mjs';

const rest = process.argv.slice(2);
const OUT = argValue(rest, 'out', null);
const report = createReport(`V-P8 공용 서버 관전 (${PUBLIC_SERVER})`);
const tag = randomBytes(4).toString('hex');
const marker = (n) => `vp8-${tag}-${n}`;
const CLEARED = Object.fromEntries(
  ['AGENT_CHAT_SERVER', 'AGENT_CHAT_NAME', 'AGENT_CHAT_ICE_SERVERS', 'AGENT_CHAT_LOG_LEVEL', 'NO_COLOR', 'AGENT_CHAT_NODE'].map((name) => [name, undefined]),
);
let stack = null;

function jsonLines(proc) {
  return proc
    .stdout()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { bad: line.length };
      }
    });
}

const count = (text, needle) => text.split(needle).length - 1;

function leftovers(name) {
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(name) && !line.includes('ps -A')).length;
  } catch {
    return -1;
  }
}

async function run() {
  const startedAt = Date.now();
  stack = await startStack({ label: 'v-p8', server: PUBLIC_SERVER });
  const room = newRoomId();
  const [a, b] = [await stack.agent(`p8a${tag.slice(0, 4)}`), await stack.agent(`p8b${tag.slice(0, 4)}`)];
  const created = await a.ok('create_room', { room_id: room });
  a.pump();
  await b.ok('join_room', { room_id: room });
  b.pump();
  report.check('P8-00', created.server === PUBLIC_SERVER && typeof created.monitor_command === 'string', 'create_room 이 공용 서버로 가고 monitor_command 를 싣는다');

  // (가) --json, 서버 인자 없음.
  const obs = `p8o${tag.slice(0, 4)}`;
  const env = { ...CLEARED, HOME: path.join(stack.homeRoot, 'home'), AGENT_CHAT_HOME: stack.home(obs) };
  const enteredAt = Date.now();
  const o = stack.procs.spawnNode(distPath('entry', 'monitor.js'), ['--json', room, '--name', obs], { name: `monitor-${obs}`, stdin: 'ignore', env });
  const snapshot = await until(() => jsonLines(o)[0], 'snapshot', 25_000, 50).catch(() => null);
  report.check(
    'P8-01',
    snapshot?.type === 'snapshot' && snapshot.participants.length === 2 && snapshot.server === PUBLIC_SERVER,
    '25초 안에 snapshot(참가자 2명, 공용 서버)',
    { ms: Date.now() - enteredAt, participants: snapshot?.participants?.length },
  );
  const seenBy = await until(
    async () => {
      const statuses = await Promise.all([a.status(), b.status()]);
      return statuses.every((status) => status.observers.some((row) => row.name === obs && row.link === 'open'));
    },
    '두 MCP 가 관전자를 본다',
    10_000,
    200,
  ).catch(() => false);
  report.check('P8-02', seenBy === true, '두 MCP 의 get_status.observers 에 관전자가 있다');

  await a.ok('send_message', { text: marker(1) });
  await b.ok('send_message', { text: marker(2) });
  await a.ok('send_message', { text: marker(3), to: [b.name] });
  const chats = await until(
    () => {
      const texts = jsonLines(o)
        .filter((line) => line.type === 'event' && line.kind === 'chat')
        .map((line) => line.text);
      return texts.includes(marker(1)) && texts.includes(marker(2)) ? texts : null;
    },
    '방 전체 글 2건',
    10_000,
    50,
  ).catch(() => null);
  await b.event((e) => e.kind === 'chat' && e.text === marker(3), { what: '대상 지정 글' }).catch(() => null);
  await delay(1_000);
  report.check(
    'P8-03',
    chats !== null && count(o.stdout(), marker(1)) === 1 && count(o.stdout(), marker(2)) === 1 && count(`${o.stdout()}${o.stderr()}`, marker(3)) === 0,
    '방 전체 글 2건이 10초 안에 한 번씩, 대상 지정 글은 0번',
  );

  // (나) 사람용 출력(셸 진입점, 서버 인자 없음).
  const obs2 = `p8h${tag.slice(0, 4)}`;
  const o2 = stack.procs.spawn('sh', [path.join(REPO_ROOT, 'scripts', 'monitor.sh'), room, '--name', obs2], {
    name: `monitor-sh-${obs2}`,
    stdin: 'ignore',
    env: { ...CLEARED, HOME: path.join(stack.homeRoot, 'home'), AGENT_CHAT_HOME: stack.home(obs2) },
  });
  const live = await until(() => o2.stdout().includes('여기부터 실시간'), '사람용 실시간 머리줄', 25_000, 50).catch(() => false);
  await until(async () => (await a.status()).observers.some((row) => row.name === obs2 && row.link === 'open'), 'a 가 O2 를 봄', 10_000, 200).catch(() => false);
  await a.ok('send_message', { text: `${marker(4)} 사람용 출력 확인\n둘째 줄` });
  const human = await until(() => o2.stdout().includes(marker(4)), '사람용 출력의 글', 10_000, 50).catch(() => false);
  report.check(
    'P8-04',
    live === true && human === true && /채팅 {8}p8a/.test(o2.stdout()) && /│ 둘째 줄/.test(o2.stdout()) && !o2.stdout().includes(room),
    '사람용 출력: 요약, 실시간 머리줄, 채팅 한 줄(여러 줄은 │ 로 잇는다). 방 ID 없음',
  );

  // 종료.
  const stops = await Promise.all([o.stop({ signal: 'SIGINT', timeoutMs: 6_000 }), o2.stop({ signal: 'SIGINT', timeoutMs: 6_000 })]);
  const lastLine = jsonLines(o).at(-1);
  report.check(
    'P8-05',
    stops.every((stop) => !stop.forced && stop.code === 0 && stop.stopMs <= 3_000) && lastLine?.type === 'end',
    'SIGINT 뒤 3초 안에 종료 코드 0(둘 다), --json 의 마지막 줄은 end',
    stops.map((stop) => ({ code: stop.code, stop_ms: stop.stopMs })),
  );
  const left = await Promise.all(
    [a, b].map((agent) => agent.event((e) => e.kind === 'peer' && e.change === 'observer_left' && e.from === obs, { timeoutMs: 5_000, what: 'observer_left' }).catch(() => null)),
  );
  report.check('P8-06', left.every((event) => event !== null), '두 MCP 가 observer_left 를 받는다');
  report.check('P8-07', !isPidAlive(o.pid) && !isPidAlive(o2.pid) && leftovers(obs) === 0 && leftovers(obs2) === 0, '관전 프로세스가 남지 않았다(sh 포함)');

  if (OUT !== null) {
    mkdirSync(OUT, { recursive: true });
    const redact = (text) => text.split(room).join('<room_id>');
    writeFileSync(path.join(OUT, 'v-p8-human.txt'), redact(`$ sh scripts/monitor.sh <room_id> --name ${obs2}\n${o2.stdout()}\n--- stderr ---\n${o2.stderr()}`), { mode: 0o600 });
    writeFileSync(path.join(OUT, 'v-p8-json.jsonl'), redact(`$ node dist/entry/monitor.js --json <room_id> --name ${obs}\n${o.stdout()}\n--- stderr ---\n${o.stderr()}`), { mode: 0o600 });
    writeFileSync(path.join(OUT, 'v-p8-monitor-command.txt'), redact(created.monitor_command), { mode: 0o600 });
  }

  await a.stopPump();
  await b.stopPump();
  await a.ok('leave_room');
  await b.ok('leave_room');
  report.check('P8-08', Date.now() - startedAt < 120_000, '전체 2분 이내(공용 서버를 짧게 썼다)', { seconds: Math.round((Date.now() - startedAt) / 1000) });
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
