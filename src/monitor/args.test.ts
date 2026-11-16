// V-U12 (monitor): parseMonitorArgs 의 표 (architecture.md 3.14 의 "인자").

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MonitorOptions, ParsedMonitorArgs } from './contract.js';
import { MONITOR_USAGE, parseMonitorArgs } from './args.js';
import { createLineSplitter, parseChatInput } from './input.js';

const ROOM = 'k3x9q0ab12cdx7p2';
const PUBLIC = 'wss://agent-chat.tools.camp';
const fixedRandom = (size: number): Uint8Array => new Uint8Array(size).fill(7);

function parse(argv: readonly string[], env: Record<string, string | undefined> = {}, tty = false): ParsedMonitorArgs {
  return parseMonitorArgs(argv, env, tty, { homeDir: '/home/tester', randomBytes: fixedRandom });
}

function run(argv: readonly string[], env: Record<string, string | undefined> = {}, tty = false): MonitorOptions {
  const parsed = parse(argv, env, tty);
  assert.equal(parsed.kind, 'run', parsed.kind === 'error' ? parsed.message : parsed.kind);
  return (parsed as Extract<ParsedMonitorArgs, { kind: 'run' }>).options;
}

function error(argv: readonly string[], env: Record<string, string | undefined> = {}): string {
  const parsed = parse(argv, env);
  assert.equal(parsed.kind, 'error', JSON.stringify(argv));
  return (parsed as Extract<ParsedMonitorArgs, { kind: 'error' }>).message;
}

describe('parseMonitorArgs: 방과 서버', () => {
  it('위치 인자 <room_id> [서버] 와 --room·--server(=값 포함)는 같다', () => {
    const forms: readonly (readonly string[])[] = [
      [ROOM, 'ws://127.0.0.1:8787'],
      ['--room', ROOM, '--server', 'ws://127.0.0.1:8787'],
      [`--room=${ROOM}`, '--server=ws://127.0.0.1:8787'],
      [ROOM, '--server', 'ws://127.0.0.1:8787'],
      ['--server', 'ws://127.0.0.1:8787', ROOM],
    ];
    for (const argv of forms) {
      const options = run(argv);
      assert.deepEqual([options.roomId, options.server, options.serverKey], [ROOM, 'ws://127.0.0.1:8787', 'ws://127.0.0.1:8787'], argv.join(' '));
    }
  });

  it('서버를 생략하면 AGENT_CHAT_SERVER, 그것도 없으면 공용 서버다', () => {
    assert.equal(run([ROOM]).serverKey, PUBLIC);
    assert.equal(run([ROOM], { AGENT_CHAT_SERVER: '  ' }).serverKey, PUBLIC);
    const fromEnv = run([ROOM], { AGENT_CHAT_SERVER: '127.0.0.1' });
    assert.equal(fromEnv.serverKey, 'ws://127.0.0.1:8787');
    assert.equal(fromEnv.session.defaultServer, '127.0.0.1');
    assert.equal(run([ROOM, 'wss://other.example'], { AGENT_CHAT_SERVER: '127.0.0.1' }).serverKey, 'wss://other.example', '인자가 먼저다');
  });

  it('잘못된 AGENT_CHAT_SERVER 를 공용 서버로 바꾸지 않고 오류다. 잘못된 서버 인자도 오류다', () => {
    assert.match(error([ROOM], { AGENT_CHAT_SERVER: 'ws://bad host' }), /AGENT_CHAT_SERVER/);
    assert.match(error([ROOM, 'ws://h.example/?q=1']), /서버 주소가 틀렸다/);
  });

  it('방 ID 와 서버를 두 번 주거나 인자가 셋이면 오류다', () => {
    assert.match(error([ROOM, '--room', ROOM]), /방 ID 를 두 번/);
    assert.match(error(['--room', ROOM, '--room', ROOM]), /--room 을 두 번/);
    assert.match(error([ROOM, 'ws://a.example', '--server', 'ws://b.example']), /서버를 두 번/);
    assert.match(error([ROOM, 'ws://a.example', 'extra']), /너무 많다/);
    assert.match(error(['--room', ROOM, 'ws://a.example']), /방 ID 를 두 번/, '--room 을 쓰면 서버는 --server 로 준다');
  });

  it('방 ID 가 없거나 형식이 틀리면 오류다. 오류 글에 방 ID 원문을 싣지 않는다', () => {
    assert.match(error([]), /방 ID 가 없다/);
    assert.match(error(['--json']), /방 ID 가 없다/);
    for (const bad of ['UPPERCASE12', 'short', 'has-dash-123', 'x'.repeat(33)]) {
      const message = error([bad]);
      assert.match(message, /소문자와 숫자 8~32자/);
      assert.equal(message.includes(bad), false);
    }
    for (const argv of [
      [ROOM, '--bogus'],
      [ROOM, '--name', 'system'],
      [ROOM, 'ws://bad host'],
    ]) {
      assert.equal(error(argv).includes(ROOM), false, argv.join(' '));
    }
  });
});

describe('parseMonitorArgs: 이름, 옵션, 환경', () => {
  it('이름을 생략하면 observer-<무작위 4자>. 참가자 이름 규칙을 따른다(예약 이름·형식)', () => {
    assert.match(run([ROOM]).name, /^observer-[a-z0-9]{4}$/);
    assert.equal(run([ROOM, '--name', 'watch-1']).name, 'watch-1');
    assert.equal(run([ROOM, '--name=watch-2']).session.name, 'watch-2');
    assert.match(error([ROOM, '--name', 'system']), /reserved/);
    assert.match(error([ROOM, '--name', 'bad name']), /--name 이 틀렸다/);
    assert.match(error([ROOM, '--name', 'x'.repeat(33)]), /--name 이 틀렸다/);
  });

  it('모르는 옵션과 값이 없는 옵션은 오류다', () => {
    assert.match(error([ROOM, '--colour']), /모르는 옵션/);
    assert.match(error([ROOM, '-x']), /모르는 옵션/);
    assert.match(error([ROOM, '--name']), /--name 에 값이 없다/);
    assert.match(error([ROOM, '--server', '--json']), /--server 에 값이 없다/);
    assert.match(error(['--room']), /--room 에 값이 없다/);
  });

  it('-h, --help 는 사용법이다(다른 인자가 틀려도)', () => {
    for (const argv of [['-h'], ['--help'], ['bad!', '--help'], [ROOM, '-h']]) {
      const parsed = parse(argv);
      assert.deepEqual(parsed, { kind: 'help', text: MONITOR_USAGE });
    }
    assert.match(MONITOR_USAGE, /agent-chat monitor <room_id> \[서버\]/);
  });

  it('--json 이 있으면 오류에도 json 표시가 붙는다', () => {
    const parsed = parse(['--json', '--bogus']);
    assert.equal(parsed.kind === 'error' && parsed.json, true);
    const plain = parse(['--bogus']);
    assert.equal(plain.kind === 'error' && plain.json, false);
  });

  it('AGENT_CHAT_ICE_SERVERS 는 MCP 와 같이 검증한다. 받지 않는 값(turn 주소 등)이면 접속하지 않고 오류다', () => {
    assert.match(error([ROOM], { AGENT_CHAT_ICE_SERVERS: 'turn:turn.example.org:3478' }), /AGENT_CHAT_ICE_SERVERS/);
    assert.match(error([ROOM], { AGENT_CHAT_ICE_SERVERS: 'stun:a.example,turns:b.example' }), /AGENT_CHAT_ICE_SERVERS/);
    const none = run([ROOM], { AGENT_CHAT_ICE_SERVERS: 'none' });
    assert.deepEqual(none.session.iceServers, { raw: 'none', parsed: { ok: true, value: [] } });
    const fallback = run([ROOM]);
    assert.equal(fallback.session.iceServers.raw, null);
    assert.equal(fallback.session.iceServers.parsed.ok, true);
  });

  it('색: stdout 이 TTY 이고 --json·--no-color·NO_COLOR 가 없을 때만 켠다(조합 전부)', () => {
    for (const tty of [true, false]) {
      for (const json of [true, false]) {
        for (const noColor of [true, false]) {
          for (const envNoColor of [undefined, '', '1']) {
            const argv = [ROOM, ...(json ? ['--json'] : []), ...(noColor ? ['--no-color'] : [])];
            const options = run(argv, envNoColor === undefined ? {} : { NO_COLOR: envNoColor }, tty);
            const expected = tty && !json && !noColor && (envNoColor === undefined || envNoColor === '');
            assert.equal(options.color, expected, JSON.stringify({ tty, json, noColor, envNoColor }));
            assert.equal(options.json, json);
          }
        }
      }
    }
  });

  it('진단 로그 위치와 수준. 세션 설정은 관전자 이름과 client monitor 다', () => {
    const options = run([ROOM, '--name', 'watch-1'], { AGENT_CHAT_HOME: '/data/ac', AGENT_CHAT_LOG_LEVEL: 'DEBUG' });
    assert.equal(options.session.home, '/data/ac');
    assert.equal(options.logLevel, 'debug');
    assert.equal(options.session.client, 'monitor');
    assert.equal(options.session.name, 'watch-1');
    const defaults = run([ROOM], { AGENT_CHAT_LOG_LEVEL: 'loud' });
    assert.equal(defaults.session.home, '/home/tester/.agent-chat');
    assert.equal(defaults.logLevel, 'info');
  });

  it('AGENT_CHAT_NAME 은 읽지 않는다(같은 PC 의 MCP 이름과 겹치지 않게)', () => {
    assert.match(run([ROOM], { AGENT_CHAT_NAME: 'claude-4kq2' }).name, /^observer-/);
  });
});

describe('관전 입력 해석', () => {
  it('글, @대상, /help, 오류', () => {
    assert.deepEqual(parseChatInput('  안녕  '), { kind: 'send', text: '안녕', to: null });
    assert.deepEqual(parseChatInput('@a,b,a 해 줘'), { kind: 'send', text: '해 줘', to: ['a', 'b'] });
    assert.deepEqual(parseChatInput('@a'), { kind: 'error', message: '@이름 뒤에 보낼 글이 없다' });
    assert.deepEqual(parseChatInput('/help'), { kind: 'help' });
    assert.equal(parseChatInput('/x').kind, 'error');
    assert.deepEqual(parseChatInput('\r'), { kind: 'empty' });
  });
  it('줄 나누기: 조각을 이어 붙이고 끝에 남은 줄을 낸다', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('ab');
    splitter.push('c\nde\n');
    splitter.push('f');
    splitter.end();
    assert.deepEqual(lines, ['abc', 'de', 'f']);
  });
});
