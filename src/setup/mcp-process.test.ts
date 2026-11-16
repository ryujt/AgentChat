// mcp-process.ts 는 등록에서 읽은 명령·인자·환경만 넘겨 프로세스를 띄운다 (architecture.md 3.13).
// 설치를 실행한 환경의 다른 변수(AGENT_CHAT_SERVER 등)가 띄운 프로세스로 새지 않아야 "등록된 그대로"다.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchMcpProcess } from './mcp-process.js';

const root = mkdtempSync(join(tmpdir(), 'agent-chat-mcpproc-'));
const dir = join(root, 'dir with spaces');
mkdirSync(dir);
const script = join(dir, 'echo env.mjs');
// 받은 인자와 환경을 파일에 적고, stdin 이 닫히면 끝난다(MCP 서버의 수명과 같다).
writeFileSync(
  script,
  [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(2), env: process.env }));',
    "process.stderr.write('started with spaces\\n');",
    "process.stdin.on('end', () => process.exit(0));",
    'process.stdin.resume();',
    '',
  ].join('\n'),
);
after(() => rmSync(root, { recursive: true, force: true }));

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('기한 안에 조건이 차지 않았다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('mcp-process', () => {
  it('등록에서 읽은 명령·인자·환경만 넘긴다', async () => {
    const out = join(dir, 'seen 1.json');
    const leaks = { AGENT_CHAT_SERVER: 'wss://leak.example', AGENT_CHAT_CLAUDE_BIN: '/leak/claude', MCP_PROCESS_TEST_SECRET: 'secret' };
    Object.assign(process.env, leaks);
    const given = { AGENT_CHAT_NAME: 'codex-ab12', AGENT_CHAT_WAIT_MAX_SEC: '540' };
    const proc = launchMcpProcess({ command: process.execPath, args: [script, out, 'extra arg'], env: given });
    try {
      assert.equal(proc.pid(), null, '띄우기 전에는 pid 가 없다');
      await proc.transport.start();
      await waitFor(() => existsSync(out));
      const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; env: Record<string, string> };
      assert.deepEqual(seen.argv, [out, 'extra arg']);
      for (const [key, value] of Object.entries(given)) assert.equal(seen.env[key], value);
      for (const key of Object.keys(leaks)) assert.equal(seen.env[key], undefined, `${key} 가 새어 나갔다`);
      // 부모 환경에서 온 것은 SDK 가 고른 안전한 변수(HOME, PATH 등)뿐이다.
      // macOS 는 프로세스마다 __CF_ 로 시작하는 변수를 스스로 넣는다. 부모가 넘긴 것이 아니다.
      const inherited = Object.keys(seen.env).filter((key) => key in process.env && !(key in given) && !key.startsWith('__CF_'));
      for (const key of inherited) assert.ok(DEFAULT_INHERITED_ENV_VARS.includes(key), `${key} 가 넘어갔다`);
    } finally {
      for (const key of Object.keys(leaks)) delete process.env[key];
      await proc.transport.close();
    }
  });

  it('pid 를 기억하고, 닫으면 프로세스가 남지 않는다', async () => {
    const out = join(dir, 'seen 2.json');
    const proc = launchMcpProcess({ command: process.execPath, args: [script, out], env: {} });
    await proc.transport.start();
    await waitFor(() => existsSync(out));
    const pid = proc.pid();
    assert.equal(typeof pid, 'number');
    assert.equal(proc.alive(), true);
    await waitFor(() => proc.stderrTail().includes('started with spaces'));
    await proc.transport.close();
    await waitFor(() => !proc.alive());
    assert.equal(proc.pid(), pid, '닫은 뒤에도 pid 를 기억한다');
    proc.kill();
  });

  it('kill 은 남은 프로세스를 끝낸다', async () => {
    const stubborn = join(dir, 'stubborn.mjs');
    writeFileSync(stubborn, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'up');\nsetInterval(() => {}, 1000);\n");
    const out = join(dir, 'seen 3.txt');
    const proc = launchMcpProcess({ command: process.execPath, args: [stubborn, out], env: {} });
    await proc.transport.start();
    await waitFor(() => existsSync(out));
    assert.equal(proc.alive(), true);
    proc.kill();
    await waitFor(() => !proc.alive());
    await proc.transport.close();
  });

  it('없는 명령은 start 가 실패한다', async () => {
    const proc = launchMcpProcess({ command: join(dir, 'no-such-node'), args: [], env: {} });
    await assert.rejects(proc.transport.start());
    assert.equal(proc.alive(), false);
  });
});
