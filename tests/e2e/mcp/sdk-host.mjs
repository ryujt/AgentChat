#!/usr/bin/env node
// 시험 보조: 호스트 흉내. MCP SDK 클라이언트로 fake-entry 를 자식으로 띄우고 그 pid 를 알린 뒤 가만히 있는다.
// "부모가 SIGKILL 되면 MCP 프로세스가 고아로 남지 않는다"를 볼 때 이 프로세스를 죽인다. 제품 코드가 아니다.
//
// 쓰는 법: node sdk-host.mjs <조종 폴더> [fake-entry 인자…]   (환경 변수는 그대로 자식에게 넘긴다)
// 출력: `SERVER_PID <pid>` 한 줄. 방에 들어가 대기를 걸어 둔 뒤에 출력한다.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [controlDir, ...entryArgs] = process.argv.slice(2);
if (controlDir === undefined) {
  console.error('쓰는 법: node sdk-host.mjs <조종 폴더> [fake-entry 인자…]');
  process.exit(1);
}

const forwarded = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_CHAT_') || key === 'HOME'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'fake-entry.mjs'), '--control', controlDir, ...entryArgs],
  env: forwarded,
  stderr: 'ignore',
});
const client = new Client({ name: 'w5-doomed-host', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);
await client.callTool({ name: 'create_room', arguments: {} });
// 열린 호출이 있는 채로 죽는 호스트를 만든다.
client.callTool({ name: 'wait_for_messages', arguments: {} }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(`SERVER_PID ${transport.pid}`);
setInterval(() => {}, 1000);
