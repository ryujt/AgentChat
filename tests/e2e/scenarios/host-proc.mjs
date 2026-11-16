#!/usr/bin/env node
// 시험 보조: 호스트 흉내. 조립한 MCP 진입점(dist/entry/mcp.js)을 MCP SDK 클라이언트로 자식으로 띄우고,
// 방에 넣고, 대기(wait_for_messages)를 걸어 둔 채 그 pid 를 알리고 가만히 있는다. 제품 코드가 아니다.
// "부모(호스트)가 SIGKILL 되면 MCP 프로세스가 고아로 남지 않는다"(V-L7 나)를 볼 때 이 프로세스를 죽인다.
//
// 쓰는 법: node host-proc.mjs <create|join> <방 ID>
//   환경 변수 가운데 AGENT_CHAT_* 와 HOME 만 자식에게 넘긴다(호스트가 등록의 env 만 넘기는 것과 같다).
// 출력: `SERVER_PID <pid>` 한 줄. 방에 들어가 대기를 걸어 둔 뒤에 출력한다. 방 ID 는 출력하지 않는다.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { distPath } from '../../support/proc.mjs';

const [mode, room] = process.argv.slice(2);
if ((mode !== 'create' && mode !== 'join') || room === undefined) {
  process.stderr.write('쓰는 법: node host-proc.mjs <create|join> <방 ID>\n');
  process.exit(2);
}

const forwarded = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_CHAT_') || key === 'HOME'));
const transport = new StdioClientTransport({ command: process.execPath, args: [distPath('entry', 'mcp.js')], env: forwarded, stderr: 'ignore' });
const client = new Client({ name: 'w9-doomed-host', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);
const entered = await client.callTool({ name: mode === 'create' ? 'create_room' : 'join_room', arguments: { room_id: room } }, undefined, { timeout: 60_000 });
if (entered.isError === true) {
  process.stderr.write('입장 실패\n');
  process.exit(1);
}
// 열린 호출이 있는 채로 죽는 호스트를 만든다.
client.callTool({ name: 'wait_for_messages', arguments: {} }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write(`SERVER_PID ${transport.pid}\n`);
setInterval(() => {}, 1000);
