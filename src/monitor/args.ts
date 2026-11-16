// 인자와 환경 변수 해석 (architecture.md 3.14 의 "인자"). 관전 도구에서 환경 변수를 해석하는 곳은 이 파일 하나다.
// 잘못된 값을 기본값으로 바꿔 접속하지 않는다(서버 주소, ICE 설정). 방 ID 를 오류 글에 싣지 않는다.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogLevel } from '../diagnostics/log-port.js';
import { DEFAULT_SERVER_URL, checkPeerName, isRoomId, normalizeServerAddress, parseIceServers, randomLowerAlnum } from '../protocol/index.js';
import type { ParseMonitorArgs, ParsedMonitorArgs } from './contract.js';

const DEFAULT_HOME_DIR_NAME = '.agent-chat';
const DEFAULT_NAME_PREFIX = 'observer-';
const DEFAULT_NAME_RANDOM_LENGTH = 4;
/** presence.client 자리의 값. 관전자는 presence 를 쓰지 않으므로 다른 참가자에게 보이지 않는다. */
const MONITOR_CLIENT = 'monitor';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const MONITOR_USAGE = `사용법: agent-chat monitor <room_id> [서버] [옵션]
       sh scripts/monitor.sh <room_id> [서버] [옵션]

방에 관전자로 들어가 에이전트들의 대화와 공유 상태를 실시간으로 보여 준다.
콘솔에 글을 입력하고 Enter 를 누르면 방의 에이전트들에게 채팅으로 보낸다(지시). 공유 상태에는 기록을 쓰지 않는다.
다른 참가자에게는 관전자로 표시되고, 보낸 글은 관전자의 글(data.observer)로 표시된다.

입력:
  <글>                          방 전체에 보낸다
  @<이름>[,<이름>…] <글>         그 참가자에게만 보낸다
  /help                         입력 안내

인자:
  <room_id>, --room <room_id>   지켜볼 방 ID (에이전트의 get_status 결과의 room.room_id)
  [서버], --server <주소>        시그널링 서버. 생략하면 AGENT_CHAT_SERVER, 그것도 없으면 ${DEFAULT_SERVER_URL}
  --name <이름>                 관전자 이름 (기본 observer-<무작위 4자>)
  --json                        stdout 에 JSON Lines 만 쓴다 (snapshot, event, notice, end, error)
  --no-color                    색을 끈다 (stdout 이 터미널이 아니면 늘 꺼진다. NO_COLOR 도 같다)
  --read-only                   입력을 받지 않는다(보기만 한다)
  -h, --help                    이 안내

보이지 않는 것: 들어오기 전의 채팅, 남끼리 주고받는 대상 지정 채팅.
관전자도 방 정원(8)을 하나 차지하고, 모든 참가자와 직접 연결돼야 들어간다(중계 없음).
끝내려면 Ctrl-C. 종료 코드: 0 끝냄, 1 입장 실패, 2 인자·설정 오류.`;

function fallbackHome(homeDir: string | undefined): string {
  if (homeDir !== undefined && homeDir !== '') return join(homeDir, DEFAULT_HOME_DIR_NAME);
  try {
    return join(homedir(), DEFAULT_HOME_DIR_NAME);
  } catch {
    return DEFAULT_HOME_DIR_NAME;
  }
}

export const parseMonitorArgs: ParseMonitorArgs = (argv, env, stdoutIsTty, options = {}) => {
  const json = argv.includes('--json');
  const fail = (message: string): ParsedMonitorArgs => ({ kind: 'error', message, json });
  const read = (name: string): string | null => {
    const value = env[name];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  // 위치 인자는 늘 <room_id> [서버] 순서다. --room 은 첫째 자리, --server 는 둘째 자리와 같고 둘 다 주면 오류다.
  let roomOption: string | null = null;
  let serverOption: string | null = null;
  let name: string | null = null;
  let noColor = false;
  let readOnly = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') return { kind: 'help', text: MONITOR_USAGE };
    if (arg === '--json') continue;
    if (arg === '--no-color') {
      noColor = true;
      continue;
    }
    if (arg === '--read-only') {
      readOnly = true;
      continue;
    }
    const match = /^--(room|server|name)(?:=(.*))?$/s.exec(arg);
    if (match !== null) {
      const key = match[1] as 'room' | 'server' | 'name';
      let value = match[2];
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) return fail(`--${key} 에 값이 없다`);
        i += 1;
      }
      if (key === 'room') {
        if (roomOption !== null) return fail('--room 을 두 번 줬다');
        roomOption = value;
      } else if (key === 'server') {
        if (serverOption !== null) return fail('--server 를 두 번 줬다');
        serverOption = value;
      } else {
        if (name !== null) return fail('--name 을 두 번 줬다');
        name = value;
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') return fail(`모르는 옵션이다: ${arg.slice(0, 40)}`);
    positional.push(arg);
  }
  if (positional.length > 2) return fail('인자가 너무 많다. agent-chat monitor <room_id> [서버] [옵션] 이다');
  if (roomOption !== null && positional.length >= 1) return fail('방 ID 를 두 번 줬다(<room_id> 와 --room 은 하나만 준다)');
  if (serverOption !== null && positional.length >= 2) return fail('서버를 두 번 줬다([서버] 와 --server 는 하나만 준다)');
  const room = roomOption ?? positional[0] ?? null;
  const server = serverOption ?? positional[1] ?? null;
  if (room === null) return fail('방 ID 가 없다. agent-chat monitor <room_id> [서버] 로 준다(-h 로 사용법)');
  // 방 ID 원문은 오류 글에 싣지 않는다(화면 공유·터미널 기록으로 퍼지지 않게).
  if (!isRoomId(room)) return fail('방 ID 는 소문자와 숫자 8~32자다');

  // 서버: 인자 → AGENT_CHAT_SERVER → 공용 서버. 잘못된 AGENT_CHAT_SERVER 를 공용 서버로 바꾸지 않는다.
  const envServer = read('AGENT_CHAT_SERVER');
  const serverRaw = server ?? envServer ?? DEFAULT_SERVER_URL;
  const address = normalizeServerAddress(serverRaw);
  if (!address.ok) {
    return fail(
      server !== null
        ? `서버 주소가 틀렸다: ${address.detail}`
        : `AGENT_CHAT_SERVER 가 서버 주소가 아니다(${address.detail}). 고치거나 서버를 인자로 준다`,
    );
  }

  const chosenName = name ?? `${DEFAULT_NAME_PREFIX}${randomLowerAlnum(DEFAULT_NAME_RANDOM_LENGTH, options.randomBytes)}`;
  const checkedName = checkPeerName(chosenName);
  if (!checkedName.ok) return fail(`--name 이 틀렸다: ${checkedName.detail}`);

  // ICE 설정은 MCP 와 같이 검증한다. TURN 등 받지 않는 값이 있으면 접속하지 않는다.
  const iceRaw = read('AGENT_CHAT_ICE_SERVERS');
  const iceParsed = parseIceServers(iceRaw);
  if (!iceParsed.ok) return fail(`AGENT_CHAT_ICE_SERVERS 를 받지 않았다: ${iceParsed.detail}`);

  const levelRaw = read('AGENT_CHAT_LOG_LEVEL')?.toLowerCase();
  const logLevel = LOG_LEVELS.find((level) => level === levelRaw) ?? 'info';
  const color = stdoutIsTty && !json && !noColor && read('NO_COLOR') === null;
  const home = read('AGENT_CHAT_HOME') ?? fallbackHome(options.homeDir);

  return {
    kind: 'run',
    options: {
      roomId: room,
      server: serverRaw,
      serverKey: address.value.serverKey,
      name: checkedName.value,
      json,
      color,
      input: !readOnly,
      logLevel,
      session: {
        defaultServer: serverRaw,
        name: checkedName.value,
        client: MONITOR_CLIENT,
        iceServers: { raw: iceRaw, parsed: iceParsed },
        home,
      },
    },
  };
};
