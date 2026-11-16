#!/usr/bin/env node
// `agent-chat` CLI 의 조립 (architecture.md 3.13). 시각·타이머·로그·환경을 만들어 setup 에 넘기는 일만 한다.
// 설치 진입점은 installer/*.sh 와 scripts/install.mjs 다. 그쪽이 이 파일을 `setup` 명령으로 실행한다.

import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileLogger } from '../diagnostics/index.js';
import type { Timers } from '../protocol/index.js';
import { EXIT_FAILED, chooseNodePath, launchMcpProcess, readInstallerEnv, runCli, transientNodeRoots } from '../setup/index.js';

const LOG_CLOSE_BUDGET_MS = 1_000;

const now = (): number => Date.now();
const timers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// 이 파일은 <패키지 뿌리>/dist/entry/cli.js 로 실행된다.
const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = readInstallerEnv(process.env, homedir(), process.cwd());
const log = createFileLogger({ dir: join(env.home, 'logs'), service: 'cli', level: 'info', now, timers });
// 셸 진입점이 찾은 Node 경로(링크 그대로)가 이 Node 와 같은 파일이고 셸 세션마다 만드는 일회용 링크가 아니면 그것을 등록한다.
// 아니면 이 Node 의 실경로다. 어느 쪽을 왜 골랐는지는 설치 출력 단계 8 에 싣는다.
const node = chooseNodePath(process.env['AGENT_CHAT_INSTALL_NODE'], process.execPath, realpathSync, process.cwd(), transientNodeRoots(process.env, tmpdir()));

const code = await runCli({
  argv: process.argv.slice(2),
  env,
  rawEnv: process.env,
  appRoot,
  nodePath: node.path,
  nodeNote: node.note,
  nodeVersion: process.versions.node,
  platform: process.platform,
  now,
  timers,
  log,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  launch: launchMcpProcess,
}).catch((error: unknown) => {
  console.error(`실패: 예상하지 못한 오류로 멈췄다(${error instanceof Error ? error.name : 'error'})`);
  return EXIT_FAILED;
});

await log.close(LOG_CLOSE_BUDGET_MS);
process.exitCode = code;
