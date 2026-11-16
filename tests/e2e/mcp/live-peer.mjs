#!/usr/bin/env node
// 시험 보조: 실제 방(공용 서버)의 "다른 참가자". V-I2·V-I3·V-I4 의 상대 참가자(peer-script)로 쓴다.
// 제품 코드가 아니다. peer-script.mjs 는 fake-entry 의 조종 폴더로만 말하므로 실제 방에는 들어가지 못한다.
// 이 스크립트는 설치된 제품 진입점(기본 ~/.agent-chat/app/dist/entry/mcp.js)을 MCP 클라이언트로 띄워
// 방을 만들고, 세션이 들어오면 정해진 간격으로 글을 보내고, 글마다 세션의 send_message 응답이 오기까지 잰다.
//
// 쓰는 법:
//   node tests/e2e/mcp/live-peer.mjs --out <폴더> --host none   [--session-name claude-a] [--late-sec 120]
//       사람이 세션을 직접 띄운다(대화형 V-I2·V-I3·V-I4). 방 ID 를 출력하고 세션이 들어오기를 기다린다(기본 15분).
//   node tests/e2e/mcp/live-peer.mjs --out <폴더> --host claude|codex [--extra <호스트 인자>]...
//       헤드리스 세션(claude -p / codex exec)을 직접 띄운다. 지시는 한 번만 프롬프트 인자로 준다.
// 선택:
//   --count 15 --interval-sec 120   보낼 글 수와 간격(V-I3·V-I4 기준값이 기본). --count 0 이면 글을 보내지 않는다
//   --late-sec <초>                 글을 다 보낸 뒤 "지금 세션에 한마디 해 턴을 끝내라"를 출력하고, 그 초만큼 뒤에
//                                   [LATE] 글 하나를 보내 5분 안에 답이 오는지 본다(V-I3 의 "한 번 더". 대화형에서만 뜻이 있다)
//   --prompt-file <파일>            헤드리스 지시문. <ROOM>, <NAME> 을 바꿔 넣는다
//   --ask <글>                      덧셈 문제 대신 이 글을 보낸다(앞에 [Qnn] 을 붙인다). V-I6 처럼 정해진 요청을 보낼 때 쓴다
//   --entry <mcp.js>                띄울 제품 진입점. 기본은 설치된 것
//   --server <주소>                 create_room 의 server. 생략하면 공용 서버
// 결과: <폴더>/summary.json (글마다 보낸 시각·답 시각·지연·5분 안 여부), runner.jsonl, peer-events.jsonl,
//       헤드리스면 session.jsonl(호스트의 stream-json/JSONL 출력)·session.err.
//       방 ID·글 본문이 들어 있다. 폴더는 0700, 파일은 0600 이다. 기록 문서에 방 ID 를 옮기지 않는다.
// 끝나면 자기가 띄운 프로세스(상대 MCP 프로세스, 헤드리스 세션)만 정리한다.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PEER = 'peer-script';
const REPLY_LIMIT_SEC = 300;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const extras = [];
argv.forEach((value, at) => {
  if (value === '--extra') extras.push(argv[at + 1]);
});
const host = opt('--host');
const outOpt = opt('--out');
if (!['claude', 'codex', 'none'].includes(host) || !outOpt) {
  console.error('쓰는 법: node tests/e2e/mcp/live-peer.mjs --out <폴더> --host claude|codex|none [--session-name <이름>] [--count 15] [--interval-sec 120] [--late-sec <초>] [--prompt-file <파일>] [--extra <인자>]...');
  process.exit(2);
}
const outDir = path.resolve(outOpt);
const sessionName = opt('--session-name', host === 'codex' ? 'codex-a' : 'claude-a');
const count = Number(opt('--count', '15'));
const intervalSec = Number(opt('--interval-sec', '120'));
const lateSec = opt('--late-sec') === undefined ? null : Number(opt('--late-sec'));
const joinLimitMs = Number(opt('--join-limit-sec', host === 'none' ? '900' : '300')) * 1000;
const hardLimitMs = Number(opt('--hard-limit-min', '50')) * 60_000;
const entry = path.resolve(opt('--entry', path.join(os.homedir(), '.agent-chat/app/dist/entry/mcp.js')));
const server = opt('--server');
const ask = opt('--ask');

mkdirSync(outDir, { recursive: true, mode: 0o700 });
const started = Date.now();
const iso = (t = Date.now()) => new Date(t).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
function log(msg, extra = {}) {
  const line = { t: iso(), msg, ...extra };
  console.log(`${line.t} ${msg}${Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ''}`);
  appendFileSync(path.join(outDir, 'runner.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}
function parse(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// 1. 상대 MCP 프로세스(제품 진입점). 기록은 이 폴더 아래의 따로 둔 AGENT_CHAT_HOME 에 쓴다.
const peerHome = path.join(outDir, 'peer-home');
mkdirSync(peerHome, { recursive: true, mode: 0o700 });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: 'pipe',
  env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), AGENT_CHAT_HOME: peerHome, AGENT_CHAT_NAME: PEER, AGENT_CHAT_CLIENT: 'peer-script', AGENT_CHAT_CHANNEL: 'off', AGENT_CHAT_WAIT_MAX_SEC: '50' },
});
const client = new Client({ name: 'agent-chat-live-peer', version: '0.0.0' });
await client.connect(transport);
const peerPid = transport.pid;
const call = async (name, args, timeout) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout }));
log('peer.start', { pid: peerPid, entry });

const created = await call('create_room', server ? { name: PEER, server } : { name: PEER }, 60_000);
if (!created.room_id) {
  log('create_room.fail', { result: created });
  await client.close();
  process.exit(1);
}
writeFileSync(path.join(outDir, 'room.json'), JSON.stringify({ room_id: created.room_id, server: created.server }), { mode: 0o600 });
log('room.created', { server: created.server, delivery_mode: created.delivery_mode });

// 2. 받기. 세션의 입장·퇴장과 글을 시각과 함께 모은다.
const state = { stopped: false, joinedAt: null, leftAt: null, leftChange: null, chats: [], peerEvents: [] };
const recvLoop = (async () => {
  let cursor;
  while (!state.stopped) {
    let result;
    try {
      result = await call('wait_for_messages', cursor ? { cursor, timeout_sec: 50 } : { timeout_sec: 50 }, 90_000);
    } catch (error) {
      log('peer.wait.error', { error: String(error?.message ?? error) });
      await sleep(1000);
      continue;
    }
    const now = Date.now();
    if (result.code) {
      log('peer.wait.code', { code: result.code });
      if (result.code === 'NOT_IN_ROOM') break;
      await sleep(1000);
      continue;
    }
    if (result.next_cursor) cursor = result.next_cursor;
    for (const event of result.events ?? []) {
      appendFileSync(path.join(outDir, 'peer-events.jsonl'), `${JSON.stringify({ recvAt: iso(now), ...event })}\n`, { mode: 0o600 });
      if (event.from !== sessionName) continue;
      if (event.kind === 'peer') {
        state.peerEvents.push({ at: iso(now), change: event.change });
        log('session.peer', { change: event.change });
        if (event.change === 'joined' && state.joinedAt === null) state.joinedAt = now;
        if (event.change === 'left' || event.change === 'disconnected') {
          state.leftAt = now;
          state.leftChange = event.change;
        }
      } else if (event.kind === 'chat') {
        state.chats.push({ at: now, text: event.text ?? '' });
        log('session.chat', { len: event.text?.length, head: String(event.text).slice(0, 60) });
      }
    }
  }
})();

// 3. 세션. none 이면 사람이 띄운다.
const childState = { exited: false, code: null, signal: null, at: null };
let child = null;
let hardTimer = null;
if (host === 'none') {
  console.log(`\n세션에 줄 방: server=${created.server} room_id=${created.room_id} 이름=${sessionName}\n`);
} else {
  const sessionCwd = path.join(outDir, 'session-cwd');
  mkdirSync(sessionCwd, { recursive: true, mode: 0o700 });
  const promptFile = opt('--prompt-file');
  const prompt = promptFile
    ? readFileSync(promptFile, 'utf8').replaceAll('<ROOM>', created.room_id).replaceAll('<NAME>', sessionName).trim()
    : `agent-chat 으로 공용 서버의 방 ${created.room_id} 에 이름 ${sessionName} 로 들어가 오는 글에 답해 줘. 30분 동안 계속하고, ${PEER} 가 끝이라고 하면 방을 나가.`;
  // 이번 실행의 도구 허용은 명령줄 인자로만 준다. 설정 파일을 고치지 않는다.
  const command = host === 'claude' ? 'claude' : 'codex';
  const commandArgs = host === 'claude'
    ? ['-p', prompt, '--allowedTools', 'mcp__agent-chat__*', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...extras]
    : ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', sessionCwd, ...extras, prompt];
  const outFd = openSync(path.join(outDir, 'session.jsonl'), 'a', 0o600);
  const errFd = openSync(path.join(outDir, 'session.err'), 'a', 0o600);
  child = spawn(command, commandArgs, { cwd: sessionCwd, stdio: ['ignore', outFd, errFd], env: process.env });
  closeSync(outFd);
  closeSync(errFd);
  child.on('exit', (code, signal) => {
    Object.assign(childState, { exited: true, code, signal, at: Date.now() });
    log('session.exit', { code, signal });
  });
  log('session.spawn', { command, args: commandArgs.map((arg) => (arg === prompt ? '<prompt>' : arg)), pid: child.pid });
  hardTimer = setTimeout(() => {
    if (childState.exited) return;
    log('session.hardlimit.kill', { pid: child.pid });
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!childState.exited) child.kill('SIGKILL');
    }, 10_000);
  }, hardLimitMs);
}
const sessionGone = () => host !== 'none' && childState.exited;

async function send(text) {
  try {
    return await call('send_message', { text }, 60_000);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}
async function waitReply(tag, sinceMs, limitMs) {
  const deadline = sinceMs + limitMs;
  while (Date.now() < deadline && state.leftAt === null && !sessionGone()) {
    if (state.chats.some((chat) => chat.at >= sinceMs && chat.text.includes(tag))) return;
    await sleep(500);
  }
}

// 4. 입장 대기와 글
const joinDeadline = Date.now() + joinLimitMs;
while (state.joinedAt === null && !sessionGone() && Date.now() < joinDeadline) await sleep(500);
const questions = [];
let late = null;
if (state.joinedAt === null) {
  log('session.join.missing', { sessionExited: host === 'none' ? null : childState.exited });
} else if (count === 0) {
  log('session.joined.nosend', { afterSec: (state.joinedAt - started) / 1000 });
  while (state.leftAt === null && !sessionGone() && Date.now() < started + hardLimitMs) await sleep(500);
} else {
  log('session.joined', { afterSec: (state.joinedAt - started) / 1000 });
  const t0 = Date.now() + 10_000;
  for (let i = 1; i <= count; i += 1) {
    await sleep(t0 + (i - 1) * intervalSec * 1000 - Date.now());
    const nn = String(i).padStart(2, '0');
    const sendAt = Date.now();
    const result = await send(ask ? `[Q${nn}] ${ask}` : `[Q${nn}] ${10 + i} 더하기 ${3 * i} 는 얼마인가요? 답 맨 앞에 [Q${nn}] 을 붙여 짧게 답해 주세요.`);
    questions.push({ q: i, sendAt, delivered: result.delivered ?? null, undelivered: result.undelivered ?? null, error: result.error ?? result.code ?? null });
    log('peer.sent', { q: i, delivered: result.delivered, undelivered: result.undelivered, error: result.error ?? result.code });
  }
  // 마지막 글의 5분. 모두 답했으면 일찍 넘어간다.
  const lastDeadline = questions.at(-1).sendAt + REPLY_LIMIT_SEC * 1000;
  while (Date.now() < lastDeadline && state.leftAt === null && !sessionGone()) {
    const answered = new Set(state.chats.map((chat) => /\[Q(\d{2})\]/.exec(chat.text)?.[1]).filter(Boolean).map(Number));
    if (questions.every((question) => answered.has(question.q))) break;
    await sleep(1000);
  }
  if (lateSec !== null && state.leftAt === null && !sessionGone()) {
    console.log(`\n지금 세션에 한마디 해서 턴을 끝내게 하라(예: "대기를 멈추고 턴을 끝내"). ${lateSec}초 뒤 [LATE] 글을 보낸다.\n`);
    log('peer.late.prompt', { lateSec });
    await sleep(lateSec * 1000);
    const sendAt = Date.now();
    const result = await send('[LATE] 늦게 보낸 글입니다. 받았다면 답 맨 앞에 [LATE] 를 붙여 짧게 답해 주세요.');
    await waitReply('[LATE]', sendAt, REPLY_LIMIT_SEC * 1000);
    const reply = state.chats.find((chat) => chat.at >= sendAt && chat.text.includes('[LATE]'));
    late = { sendAt: iso(sendAt), delivered: result.delivered ?? null, replyAt: reply ? iso(reply.at) : null, latencySec: reply ? (reply.at - sendAt) / 1000 : null };
    log('peer.late.result', late);
  }
  const endResult = await send(`[END] ${PEER} 입니다. 끝입니다. 시험을 마쳤으니 방을 나가 주세요.`);
  state.endSentAt = Date.now();
  log('peer.end.sent', { delivered: endResult.delivered, undelivered: endResult.undelivered });
}

// 5. 세션의 퇴장과 종료를 기다리고, 자기가 띄운 것만 정리한다.
// 들어온 적이 없으면 퇴장을 기다리지 않는다.
const leaveDeadline = state.joinedAt === null ? 0 : Date.now() + 300_000;
while (state.leftAt === null && !sessionGone() && Date.now() < leaveDeadline) await sleep(500);
if (child !== null) {
  const exitDeadline = Date.now() + 300_000;
  while (!childState.exited && Date.now() < exitDeadline) await sleep(500);
  if (!childState.exited) {
    log('session.exit.timeout.kill', { pid: child.pid });
    child.kill('SIGTERM');
    await sleep(10_000);
    if (!childState.exited) child.kill('SIGKILL');
    await sleep(1000);
  }
}
if (hardTimer !== null) clearTimeout(hardTimer);
await sleep(3000);
state.stopped = true;
let leave;
try {
  leave = await call('leave_room', {}, 60_000);
} catch (error) {
  leave = { error: String(error?.message ?? error) };
}
log('peer.leave', { left: leave.left, undelivered_events: leave.undelivered_events });
await Promise.race([recvLoop, sleep(60_000)]);
await client.close();
await sleep(2000);
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 6. 글과 답의 짝: 답에 든 [Qnn] 으로, 없으면 보낸 뒤 처음 온 표지 없는 답으로.
const used = new Set();
for (const question of questions) {
  const tag = `[Q${String(question.q).padStart(2, '0')}]`;
  let index = state.chats.findIndex((chat, at) => !used.has(at) && chat.text.includes(tag));
  let matchedBy = 'tag';
  if (index < 0) {
    index = state.chats.findIndex((chat, at) => !used.has(at) && chat.at >= question.sendAt && !/\[(Q\d{2}|LATE)\]/.test(chat.text));
    matchedBy = 'order';
  }
  if (index >= 0) {
    used.add(index);
    Object.assign(question, { replyAt: state.chats[index].at, latencySec: (state.chats[index].at - question.sendAt) / 1000, matchedBy, replyText: state.chats[index].text });
  }
  question.pass = question.latencySec !== undefined && question.latencySec >= 0 && question.latencySec <= REPLY_LIMIT_SEC;
}
const summary = {
  host, sessionName, startedAt: iso(started), endedAt: iso(),
  joinedAt: state.joinedAt ? iso(state.joinedAt) : null, joinAfterSec: state.joinedAt ? (state.joinedAt - started) / 1000 : null,
  leftAt: state.leftAt ? iso(state.leftAt) : null, leftChange: state.leftChange, endSentAt: state.endSentAt ? iso(state.endSentAt) : null,
  session: child === null ? null : { pid: child.pid, ...childState, at: childState.at ? iso(childState.at) : null, aliveAfter: alive(child.pid) },
  peer: { pid: peerPid, aliveAfter: alive(peerPid), leave },
  questions: questions.map((question) => ({ ...question, sendAt: iso(question.sendAt), replyAt: question.replyAt ? iso(question.replyAt) : null })),
  passCount: questions.filter((question) => question.pass).length, total: count, late,
  otherChats: state.chats.filter((_, at) => !used.has(at)).map((chat) => ({ at: iso(chat.at), text: chat.text })),
  peerEvents: state.peerEvents,
};
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
log('done', { pass: summary.passCount, total: count, late: late?.replyAt ? 'handled' : late ? 'not_handled' : 'not_run', sessionAlive: summary.session?.aliveAfter ?? null, peerAlive: summary.peer.aliveAfter });
process.exit(0);
