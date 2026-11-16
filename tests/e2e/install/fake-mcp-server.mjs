// 시험 전용: 가짜 Agent Chat MCP 서버. 설치 시험이 `<app>/dist/entry/mcp.js` 자리에 이 파일을 복사해 둔다.
// 실제 MCP 진입점(src/entry/mcp.ts)은 다른 묶음이 조립한다. 여기서는 doctor 가 부르는 tool 여섯 개만
// 같은 결과 모양으로 답한다. 네트워크에 닿지 않는다. 두 프로세스는 임시 폴더의 파일로 글을 주고받는다.
//
// 상태 폴더: <HOME 의 부모>/fake-mcp-state (doctor 가 띄운 프로세스는 등록된 환경과 HOME·PATH 만 받는다)
//   launches.jsonl  띄워질 때 받은 인자와 AGENT_CHAT_* 환경
//   calls.jsonl     받은 tool 호출의 이름과 인자
//   options.json    시험이 주는 동작: { createError, joinError, srflxSeen, stun, dropChat, lingerMs }

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const stateDir = path.join(path.dirname(process.env.HOME ?? '.'), 'fake-mcp-state');
const roomsDir = path.join(stateDir, 'rooms');
mkdirSync(roomsDir, { recursive: true });

const options = existsSync(path.join(stateDir, 'options.json')) ? JSON.parse(readFileSync(path.join(stateDir, 'options.json'), 'utf8')) : {};
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_CHAT_')));
appendFileSync(
  path.join(stateDir, 'launches.jsonl'),
  `${JSON.stringify({ pid: process.pid, node: process.execPath, script: process.argv[1], args: process.argv.slice(2), env: ownEnv, cwd: process.cwd() })}\n`,
);

const TOOLS = ['create_room', 'join_room', 'leave_room', 'get_status', 'send_message', 'wait_for_messages'];
const self = { room: null, name: '' };

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }] });
const fail = (code, details) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: `fake ${code}`, details } }) }] });

const membersFile = (room) => path.join(roomsDir, `${room}.members.json`);
const inboxFile = (room, name) => path.join(roomsDir, `${room}.${name}.jsonl`);
const members = (room) => (existsSync(membersFile(room)) ? JSON.parse(readFileSync(membersFile(room), 'utf8')) : null);
const inbox = (room, name) => (existsSync(inboxFile(room, name)) ? readFileSync(inboxFile(room, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(name, args) {
  appendFileSync(path.join(stateDir, 'calls.jsonl'), `${JSON.stringify({ name, args })}\n`);
  if (name === 'create_room') {
    if (options.createError) return fail(options.createError);
    self.room = `fakeroom${process.pid}`;
    self.name = String(args.name);
    writeFileSync(membersFile(self.room), JSON.stringify([self.name]));
    return ok({ room_id: self.room, server: typeof args.server === 'string' ? args.server : 'wss://agent-chat.tools.camp', name: self.name, participants: [], delivery_mode: 'poll' });
  }
  if (name === 'join_room') {
    if (options.joinError) return fail(options.joinError, { timeout_ms: 20000, peers: [{ name: 'peer', stage: 'ice', reason: 'ice_timeout' }] });
    const current = members(String(args.room_id));
    if (current === null) return fail('SIGNALING_ERROR', { server_code: 'ROOM_NOT_FOUND' });
    self.room = String(args.room_id);
    self.name = String(args.name);
    writeFileSync(membersFile(self.room), JSON.stringify([...current, self.name]));
    return ok({ room_id: self.room, server: args.server ?? 'wss://agent-chat.tools.camp', name: self.name, participants: [], test: null, delivery_mode: 'poll' });
  }
  if (self.room === null) return fail('NOT_IN_ROOM');
  const others = (members(self.room) ?? []).filter((member) => member !== self.name);
  if (name === 'send_message') {
    if (options.dropChat !== true) {
      for (const member of others) {
        const cursor = inbox(self.room, member).length + 1;
        appendFileSync(inboxFile(self.room, member), `${JSON.stringify({ cursor: String(cursor), id: `m-${cursor}`, kind: 'chat', from: self.name, to: 'room', text: String(args.text) })}\n`);
      }
    }
    return ok({ message_id: 'fake-1', delivered: others, undelivered: [] });
  }
  if (name === 'wait_for_messages') {
    const after = typeof args.cursor === 'string' ? Number(args.cursor) : 0;
    // 실제 서버처럼 기다리되, 시험이 길어지지 않게 1초까지만 기다린다.
    const deadline = Date.now() + Math.min(Number(args.timeout_sec ?? 1) * 1000, 1000);
    for (;;) {
      const all = inbox(self.room, self.name);
      if (all.length > after) return ok({ status: 'events', events: all.slice(after), next_cursor: String(all.length), more: false });
      if (Date.now() >= deadline) return ok({ status: 'timeout', events: [], next_cursor: String(all.length), more: false });
      await sleep(25);
    }
  }
  if (name === 'get_status') {
    return ok({
      room: { room_id: self.room, server: 'wss://agent-chat.tools.camp', name: self.name, signaling: 'connected', net: { stun: options.stun ?? true, srflx_seen: options.srflxSeen ?? true } },
      delivery_mode: 'poll',
      participants: others.map((member) => ({ name: member, link: 'open', shown_as: 'not_ready' })),
      test: null,
      warnings: [],
    });
  }
  if (name === 'leave_room') {
    writeFileSync(membersFile(self.room), JSON.stringify(others));
    self.room = null;
    return ok({ left: true, transcript_path: null, undelivered_events: 0 });
  }
  return fail('INVALID_ARGUMENT');
}

const server = new Server({ name: 'agent-chat', version: '0.0.0-fake' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) }));
server.setRequestHandler(CallToolRequestSchema, (request) => call(request.params.name, request.params.arguments ?? {}));

// SDK 는 stdin 이 닫혀도 프로세스를 끝내 주지 않는다. 호스트가 닫으면 스스로 끝난다.
const exit = () => setTimeout(() => process.exit(0), Number(options.lingerMs ?? 0));
process.stdin.on('end', exit);
process.stdin.on('close', exit);
await server.connect(new StdioServerTransport());
