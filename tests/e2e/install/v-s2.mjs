#!/usr/bin/env node
// V-S2: V-S1 이 넣은 등록의 명령과 환경 그대로 MCP 프로세스 둘을 띄워 통신한다 (verification-plan.md 3.4).
//
// 등록은 호스트 CLI 로 읽기만 한다(`claude mcp get agent-chat`, `codex mcp get agent-chat --json`). 등록·제거는 하지 않는다.
// 이름만 name 인자로 다르게 주고 server 는 생략한다(등록된 환경, 없으면 공용 서버).
//   create_room → join_room → 양방향 send_message 가 delivered → 양쪽 wait_for_messages 로 수신
//   → get_status 의 상대가 not_ready 또는 ready → leave_room → 프로세스가 남지 않는다 → agent-chat doctor 가 종료 코드 0
//
// 사용법:
//   node tests/e2e/install/v-s2.mjs [--server <주소>]
//
//   --server  create_room 과 doctor 에 줄 서버 주소. V-S2 자체는 주지 않고 실행한다(공용 서버).
//             공용 서버가 없을 때 자체 호스팅 서버로 미리 돌려 볼 때만 쓴다.
//
// 환경변수: AGENT_CHAT_HOME, AGENT_CHAT_CLAUDE_BIN, AGENT_CHAT_CODEX_BIN (설치기의 것과 같다).
// 설치 코드(src/setup)를 import 하지 않는다. 등록을 읽고 프로세스를 띄우는 길을 설치와 따로 둔다.
//
// 종료 코드: 0 = 모든 항목 통과, 1 = 실패가 있다, 2 = 실행하지 못했다(등록이 없음 등).

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const NAME = 'agent-chat';
const LIMITS = { initMs: 10_000, createMs: 15_000, joinMs: 40_000, messageMs: 15_000, exitMs: 5_000 };

const args = process.argv.slice(2);
const serverAt = args.indexOf('--server');
const server = serverAt >= 0 ? args[serverAt + 1] : null;
if (args.length !== (serverAt >= 0 ? 2 : 0) || (serverAt >= 0 && !server)) {
  console.error('사용법: node tests/e2e/install/v-s2.mjs [--server <주소>]');
  process.exit(2);
}

const agentHome = process.env.AGENT_CHAT_HOME && process.env.AGENT_CHAT_HOME.trim() !== '' ? path.resolve(process.env.AGENT_CHAT_HOME) : path.join(os.homedir(), '.agent-chat');
const bins = { claude: process.env.AGENT_CHAT_CLAUDE_BIN || 'claude', codex: process.env.AGENT_CHAT_CODEX_BIN || 'codex' };
const results = [];

function record(id, title, pass, detail = '') {
  results.push({ id, pass });
  console.log(`${id} ${title}: ${pass ? '통과' : '실패'}${detail === '' ? '' : ` — ${detail}`}`);
  return pass;
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 120_000 });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '' };
}

/** 등록을 읽는다. 없거나 이 설치를 가리키지 않으면 null. */
function readRegistration(host, entry) {
  if (host === 'claude') {
    const got = capture(bins.claude, ['mcp', 'get', NAME]);
    if (!got.ok) return null;
    const lines = got.stdout.split('\n');
    const field = (name) => lines.find((line) => line.trimStart().startsWith(`${name}:`))?.trimStart().slice(name.length + 1).trim();
    const env = {};
    for (const line of lines.slice(lines.findIndex((candidate) => candidate.trim() === 'Environment:') + 1)) {
      const match = /^\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (match === null) break;
      env[match[1]] = match[2];
    }
    // CLI 는 인자를 공백으로 이어 보여 준다. 글이 이 설치의 진입점과 같으면 그 경로 하나다.
    return field('Command') && field('Args') === entry ? { host, command: field('Command'), args: [entry], env } : null;
  }
  const got = capture(bins.codex, ['mcp', 'get', NAME, '--json']);
  if (!got.ok) return null;
  try {
    const transport = JSON.parse(got.stdout).transport;
    return transport.args?.[0] === entry ? { host, command: transport.command, args: transport.args, env: transport.env ?? {} } : null;
  } catch {
    return null;
  }
}

async function callTool(client, name, toolArgs, timeout) {
  try {
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout });
    const body = JSON.parse(result.content?.[0]?.text ?? 'null');
    return result.isError || body?.ok !== true ? { ok: false, code: body?.error?.code ?? 'BAD_TOOL_RESULT', details: body?.error?.details } : { ok: true, data: body };
  } catch (error) {
    return { ok: false, code: error?.code === -32001 ? 'TIMEOUT' : (error?.name ?? 'MCP_ERROR') };
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const sessions = [];

/** 등록된 명령·인자·환경만 넘겨 프로세스를 띄운다. */
async function start(registration, label) {
  const transport = new StdioClientTransport({ command: registration.command, args: [...registration.args], env: { ...registration.env }, stderr: 'ignore' });
  const client = new Client({ name: 'agent-chat-v-s2', version: '1' });
  const session = { client, transport, pid: null, name: `vs2-${label}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`, inRoom: false };
  sessions.push(session);
  try {
    await client.connect(transport, { timeout: LIMITS.initMs });
  } finally {
    // 초기화에 실패해도 띄운 프로세스는 정리해야 한다.
    session.pid = transport.pid;
  }
  return session;
}

/** 받는 쪽이 보낸 쪽의 글을 수신함에서 꺼낼 때까지 기다린다. */
async function received(receiver, from, text) {
  const deadline = Date.now() + LIMITS.messageMs;
  let cursor;
  while (Date.now() < deadline) {
    const waited = await callTool(receiver.client, 'wait_for_messages', cursor === undefined ? { timeout_sec: 5 } : { timeout_sec: 5, cursor }, 15_000);
    if (!waited.ok) return false;
    if ((waited.data.events ?? []).some((event) => event.kind === 'chat' && event.from === from && event.text === text)) return true;
    cursor = waited.data.next_cursor;
  }
  return false;
}

async function main() {
  const entry = path.join(realpathSync(path.join(agentHome, 'app')), 'dist', 'entry', 'mcp.js');
  const registrations = ['claude', 'codex'].map((host) => readRegistration(host, entry)).filter((registration) => registration !== null);
  if (registrations.length === 0) {
    console.error(`실행하지 못했다. 이 설치(${entry})를 가리키는 ${NAME} 등록이 없다. 먼저 V-S1 을 실행한다.`);
    return 2;
  }
  const [first, second = first] = registrations;
  console.log(`등록: ${registrations.map((registration) => registration.host).join(', ')} (A 는 ${first.host}, B 는 ${second.host} 의 등록으로 띄운다)`);

  const a = await start(first, 'a');
  const b = await start(second, 'b');
  record('S2-01', '등록된 명령과 환경 그대로 MCP 프로세스 둘이 뜬다', a.pid !== null && b.pid !== null);

  const created = await callTool(a.client, 'create_room', server === null ? { name: a.name } : { name: a.name, server }, LIMITS.createMs);
  a.inRoom = created.ok;
  if (!record('S2-02', 'create_room 이 성공한다', created.ok, created.ok ? String(created.data.server) : created.code)) return 1;

  const joined = await callTool(b.client, 'join_room', server === null ? { room_id: created.data.room_id, name: b.name } : { room_id: created.data.room_id, name: b.name, server }, LIMITS.joinMs);
  b.inRoom = joined.ok;
  const stage = joined.ok ? '' : `${joined.code} ${(joined.details?.peers ?? []).map((peer) => `stage=${peer.stage} reason=${peer.reason}`).join(', ')}`;
  if (!record('S2-03', 'join_room 이 성공한다', joined.ok, stage)) return 1;

  for (const [id, sender, receiver] of [['S2-04', a, b], ['S2-05', b, a]]) {
    const text = `v-s2 ${sender.name} → ${receiver.name}`;
    const sent = await callTool(sender.client, 'send_message', { text }, LIMITS.messageMs);
    const delivered = sent.ok && (sent.data.delivered ?? []).includes(receiver.name);
    const got = delivered && (await received(receiver, sender.name, text));
    record(id, `${sender === a ? 'A → B' : 'B → A'}: send_message 가 delivered 이고 wait_for_messages 로 받는다`, got, delivered ? '' : (sent.code ?? 'delivered 에 상대가 없다'));
  }

  for (const [id, self, peer] of [['S2-06', a, b], ['S2-07', b, a]]) {
    const status = await callTool(self.client, 'get_status', {}, LIMITS.messageMs);
    const shown = status.ok ? (status.data.participants ?? []).find((participant) => participant.name === peer.name)?.shown_as : undefined;
    record(id, `${self === a ? 'A' : 'B'} 의 get_status 에서 상대가 not_ready 또는 ready 다`, shown === 'not_ready' || shown === 'ready', String(shown));
  }
  return null;
}

let code;
try {
  code = await main();
} catch (error) {
  record('S2-00', '예상하지 못한 오류 없이 끝난다', false, error instanceof Error ? error.name : 'error');
  code = 1;
}

// 정리: 방을 나가고 프로세스를 닫는다. 남은 프로세스가 없어야 한다.
if (sessions.length > 0) {
  let left = true;
  for (const session of sessions) {
    if (session.inRoom) left = (await callTool(session.client, 'leave_room', {}, LIMITS.exitMs)).ok && left;
  }
  const startedAt = Date.now();
  await Promise.all(sessions.map((session) => session.client.close().catch(() => undefined)));
  const leftover = sessions.filter((session) => session.pid !== null && alive(session.pid));
  for (const session of leftover) process.kill(session.pid, 'SIGKILL');
  record('S2-08', 'leave_room 뒤 프로세스가 남지 않는다', left && leftover.length === 0, `${Date.now() - startedAt}ms${leftover.length === 0 ? '' : `, 남은 프로세스 ${leftover.length}개를 강제로 끝냈다`}`);
}

if (code === null) {
  const cli = path.join(agentHome, 'app', 'dist', 'entry', 'cli.js');
  const doctor = spawnSync(process.execPath, server === null ? [cli, 'doctor'] : [cli, 'doctor', '--server', server], { encoding: 'utf8', timeout: 300_000 });
  for (const line of (doctor.stdout ?? '').split('\n').filter((text) => text !== '')) console.log(`    | ${line}`);
  record('S2-09', 'agent-chat doctor 의 종료 코드가 0 이다', doctor.status === 0, `종료 코드 ${doctor.status}`);
}

const failed = results.filter((result) => !result.pass);
if (code !== 2) {
  console.log(`\nV-S2 결과: ${results.length - failed.length}/${results.length} 통과${failed.length === 0 ? '' : ` (실패: ${failed.map((result) => result.id).join(', ')})`}`);
  console.log('한계: 두 프로세스가 같은 PC 다. 호스트 자체가 서버를 띄우는 것과 다른 PC 사이의 NAT 통과는 이 검증이 보지 않는다.');
}
process.exit(code === 2 ? 2 : failed.length === 0 ? 0 : 1);
