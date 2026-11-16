// loadConfig: 환경 변수 해석 (architecture.md 5절). 값이 잘못돼도 실패하지 않는다. 증거 수준은 대역이다.

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RoomSessionDeps } from '../room-session/contract.js';
import { loadConfig } from './config.js';
import type { ConfigEnvName, LoadConfigResult } from './contract.js';

const HOME = { homeDir: '/home/tester' };

function load(env: Readonly<Record<string, string | undefined>>): LoadConfigResult {
  return loadConfig(env, HOME);
}

function problemNames(result: LoadConfigResult): ConfigEnvName[] {
  return result.problems.map((problem) => problem.name);
}

describe('loadConfig: 기본값', () => {
  it('환경 변수가 하나도 없으면 설계의 기본값을 쓴다', () => {
    const { config, problems } = load({});
    assert.deepEqual(problems, []);
    assert.equal(config.session.defaultServer, null);
    assert.match(config.session.name, /^agent-[0-9a-z]{6}$/);
    assert.equal(config.session.client, 'unknown');
    assert.equal(config.session.iceServers.raw, null);
    assert.deepEqual(config.session.iceServers.parsed, {
      ok: true,
      value: [{ url: 'stun:stun.l.google.com:19302', hostname: 'stun.l.google.com', port: 19302 }],
    });
    assert.equal(config.session.home, join('/home/tester', '.agent-chat'));
    assert.equal(config.channel, 'auto');
    assert.equal(config.waitMaxSec, 50);
    assert.equal(config.logLevel, 'info');
  });

  it('기본 이름은 부를 때마다 새로 만든다. 무작위 공급자를 주면 그것을 쓴다', () => {
    assert.notEqual(load({}).config.session.name, load({}).config.session.name);
    const fixed = loadConfig({}, { ...HOME, randomBytes: (size) => new Uint8Array(size).fill(10) });
    assert.equal(fixed.config.session.name, 'agent-aaaaaa');
  });

  it('homeDir 를 주지 않으면 OS 의 홈을 쓴다', () => {
    assert.equal(loadConfig({}).config.session.home, join(homedir(), '.agent-chat'));
  });

  it('빈 값과 공백뿐인 값은 없는 것으로 본다', () => {
    const { config, problems } = load({
      AGENT_CHAT_SERVER: '',
      AGENT_CHAT_NAME: '   ',
      AGENT_CHAT_CLIENT: '',
      AGENT_CHAT_ICE_SERVERS: ' ',
      AGENT_CHAT_CHANNEL: '',
      AGENT_CHAT_WAIT_MAX_SEC: '',
      AGENT_CHAT_HOME: '',
      AGENT_CHAT_LOG_LEVEL: '',
    });
    assert.deepEqual(problems, []);
    assert.equal(config.session.defaultServer, null);
    assert.equal(config.session.iceServers.raw, null);
    assert.equal(config.session.home, join('/home/tester', '.agent-chat'));
    assert.equal(config.waitMaxSec, 50);
  });
});

describe('loadConfig: 올바른 값', () => {
  it('준 값을 그대로 쓴다', () => {
    const { config, problems } = load({
      AGENT_CHAT_SERVER: 'chat.example.com',
      AGENT_CHAT_NAME: 'claude-4kq2',
      AGENT_CHAT_CLIENT: 'claude-code',
      AGENT_CHAT_ICE_SERVERS: 'stun:stun.example.com:3478,stun:[2001:db8::1]',
      AGENT_CHAT_CHANNEL: 'off',
      AGENT_CHAT_WAIT_MAX_SEC: '100',
      AGENT_CHAT_HOME: '/data/agent-chat',
      AGENT_CHAT_LOG_LEVEL: 'debug',
    });
    assert.deepEqual(problems, []);
    assert.equal(config.session.defaultServer, 'chat.example.com');
    assert.equal(config.session.name, 'claude-4kq2');
    assert.equal(config.session.client, 'claude-code');
    assert.equal(config.session.iceServers.raw, 'stun:stun.example.com:3478,stun:[2001:db8::1]');
    assert.equal(config.session.iceServers.parsed.ok, true);
    assert.equal(config.session.home, '/data/agent-chat');
    assert.equal(config.channel, 'off');
    assert.equal(config.waitMaxSec, 100);
    assert.equal(config.logLevel, 'debug');
  });

  it('대기 상한은 5 와 540 을 받는다', () => {
    assert.equal(load({ AGENT_CHAT_WAIT_MAX_SEC: '5' }).config.waitMaxSec, 5);
    assert.equal(load({ AGENT_CHAT_WAIT_MAX_SEC: '540' }).config.waitMaxSec, 540);
  });

  it('none 은 STUN 없이 host 후보만 쓰겠다는 설정이다', () => {
    const { config, problems } = load({ AGENT_CHAT_ICE_SERVERS: 'none' });
    assert.deepEqual(problems, []);
    assert.deepEqual(config.session.iceServers, { raw: 'none', parsed: { ok: true, value: [] } });
  });

  it('채널 설정과 로그 수준은 대소문자를 가리지 않는다. 앞뒤 공백은 뗀다', () => {
    const { config, problems } = load({ AGENT_CHAT_CHANNEL: ' OFF ', AGENT_CHAT_LOG_LEVEL: 'WARN', AGENT_CHAT_NAME: ' codex-7f3k ' });
    assert.deepEqual(problems, []);
    assert.equal(config.channel, 'off');
    assert.equal(config.logLevel, 'warn');
    assert.equal(config.session.name, 'codex-7f3k');
  });

  it('결과의 session 은 room-session 의 설정으로 그대로 넘길 수 있다', () => {
    const config: RoomSessionDeps['config'] = load({}).config.session;
    assert.equal(typeof config.name, 'string');
  });
});

describe('loadConfig: 잘못된 값으로도 실패하지 않는다', () => {
  it('이름이 형식에 맞지 않거나 예약 이름이면 무작위 기본 이름을 쓰고 알린다', () => {
    for (const bad of ['system', 'ROOM', 'has space', '-leading', 'a'.repeat(33), '이름']) {
      const result = load({ AGENT_CHAT_NAME: bad });
      assert.match(result.config.session.name, /^agent-[0-9a-z]{6}$/, bad);
      assert.deepEqual(problemNames(result), ['AGENT_CHAT_NAME'], bad);
      assert.equal(result.problems[0]?.effect, 'default_used');
    }
  });

  it('클라이언트, 채널, 대기 상한, 로그 수준이 잘못되면 기본값을 쓰고 알린다', () => {
    const result = load({
      AGENT_CHAT_CLIENT: 'claude code!',
      AGENT_CHAT_CHANNEL: 'on',
      AGENT_CHAT_WAIT_MAX_SEC: 'abc',
      AGENT_CHAT_LOG_LEVEL: 'loud',
    });
    assert.equal(result.config.session.client, 'unknown');
    assert.equal(result.config.channel, 'auto');
    assert.equal(result.config.waitMaxSec, 50);
    assert.equal(result.config.logLevel, 'info');
    assert.deepEqual(result.problems, [
      { name: 'AGENT_CHAT_CLIENT', reason: 'must be 1-64 characters of letters, digits, ".", "_" or "-"', effect: 'default_used' },
      { name: 'AGENT_CHAT_CHANNEL', reason: 'must be auto or off', effect: 'default_used' },
      { name: 'AGENT_CHAT_WAIT_MAX_SEC', reason: 'not an integer', effect: 'default_used' },
      { name: 'AGENT_CHAT_LOG_LEVEL', reason: 'must be debug, info, warn or error', effect: 'default_used' },
    ]);
  });

  it('대기 상한이 정수가 아니거나 5~540 밖이면 50 을 쓴다', () => {
    for (const [value, reason] of [
      ['4', 'out of range 5-540'],
      ['541', 'out of range 5-540'],
      ['0', 'out of range 5-540'],
      ['99999999999', 'not an integer'],
      ['1.5', 'not an integer'],
      ['-10', 'not an integer'],
      ['50s', 'not an integer'],
      ['1e2', 'not an integer'],
    ] as const) {
      const result = load({ AGENT_CHAT_WAIT_MAX_SEC: value });
      assert.equal(result.config.waitMaxSec, 50, value);
      assert.deepEqual(result.problems, [{ name: 'AGENT_CHAT_WAIT_MAX_SEC', reason, effect: 'default_used' }], value);
    }
  });

  it('ICE 설정은 기본값으로 바꾸지 않는다. 원문과 거절 결과를 함께 넘긴다', () => {
    for (const bad of ['turn:user:secret-marker@relay.example.com', 'stun:ok.example.com,turns:relay.example.com', 'stuns:x.example.com', 'http://x']) {
      const result = load({ AGENT_CHAT_ICE_SERVERS: bad });
      assert.equal(result.config.session.iceServers.raw, bad);
      assert.equal(result.config.session.iceServers.parsed.ok, false, bad);
      if (!result.config.session.iceServers.parsed.ok) {
        assert.equal(result.config.session.iceServers.parsed.code, 'ICE_CONFIG_REJECTED');
      }
      assert.deepEqual(problemNames(result), ['AGENT_CHAT_ICE_SERVERS']);
      assert.equal(result.problems[0]?.effect, 'rejected_on_use');
    }
  });

  it('잘못된 서버 주소는 공용 서버로 바꾸지 않는다. 원문을 넘기고 쓸 때 거절되게 둔다', () => {
    const result = load({ AGENT_CHAT_SERVER: 'ftp://files.example.com' });
    assert.equal(result.config.session.defaultServer, 'ftp://files.example.com');
    assert.deepEqual(result.problems, [
      { name: 'AGENT_CHAT_SERVER', reason: 'server address scheme must be ws, wss, http or https', effect: 'rejected_on_use' },
    ]);
  });

  it('사유에 값의 원문을 싣지 않는다', () => {
    const marker = 'zq-secret-marker';
    const result = load({
      AGENT_CHAT_SERVER: `wss://${marker}.example.com/?token=${marker}`,
      AGENT_CHAT_NAME: `${marker} with space`,
      AGENT_CHAT_CLIENT: `${marker}!`,
      AGENT_CHAT_ICE_SERVERS: `turn:user:${marker}@relay.example.com`,
      AGENT_CHAT_CHANNEL: marker,
      AGENT_CHAT_WAIT_MAX_SEC: marker,
      AGENT_CHAT_LOG_LEVEL: marker,
    });
    assert.equal(result.problems.length, 7);
    assert.equal(JSON.stringify(result.problems).includes(marker), false);
  });

  it('모든 값이 잘못돼도 던지지 않고 쓸 수 있는 설정을 돌려준다', () => {
    const env: Record<string, string | undefined> = {
      AGENT_CHAT_SERVER: '\u0000',
      AGENT_CHAT_NAME: '\n',
      AGENT_CHAT_CLIENT: '🙂',
      AGENT_CHAT_ICE_SERVERS: ',,,',
      AGENT_CHAT_CHANNEL: '0',
      AGENT_CHAT_WAIT_MAX_SEC: 'NaN',
      AGENT_CHAT_HOME: undefined,
      AGENT_CHAT_LOG_LEVEL: 'trace',
      AGENT_CHAT_UNKNOWN: 'ignored',
      PATH: '/usr/bin',
    };
    let result: LoadConfigResult | null = null;
    assert.doesNotThrow(() => {
      result = load(env);
    });
    const loaded = result as LoadConfigResult | null;
    assert.ok(loaded !== null);
    assert.match(loaded.config.session.name, /^agent-[0-9a-z]{6}$/);
    assert.equal(loaded.config.waitMaxSec, 50);
    assert.equal(loaded.config.channel, 'auto');
  });

  it('AGENT_CHAT_HOME 은 검사하지 않는다', () => {
    const result = load({ AGENT_CHAT_HOME: '/definitely/not/writable/\u0001' });
    assert.equal(result.config.session.home, '/definitely/not/writable/\u0001');
    assert.deepEqual(result.problems, []);
  });
});
