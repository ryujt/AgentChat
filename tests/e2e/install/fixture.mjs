// 시험 전용: 설치 시험이 쓰는 임시 세계. tests/e2e/install/*.test.mjs 와 installer/*.test.mjs 가 함께 쓴다.
//
// 공백이 든 임시 폴더에 가짜 홈, 설치 위치(<AGENT_CHAT_HOME>/app), 가짜 호스트 CLI, 가짜 npm 을 만든다.
// 설치기와 빌드 결과는 저장소에서 복사한다. 실제 사용자 홈의 설정에는 닿지 않는다:
//   - HOME 은 임시 폴더다. 가짜 호스트 CLI 는 HOME 에 표식 파일이 있을 때만 쓴다.
//   - PATH 는 시험용 bin 폴더와 /usr/bin, /bin 뿐이다. 이 PC 의 실제 claude·codex 는 PATH 에 없다.
//   - 환경은 새로 만든다. 시험을 돌리는 세션의 환경 변수를 물려주지 않는다.
//
// npm ci 와 npm run build 는 PATH 앞의 가짜 npm 이 대신한다(인자만 적고 끝난다). 빌드 결과는 미리 만든
// 것을 복사한다(AGENT_CHAT_DIST, 기본 <저장소>/dist). 실제 npm ci 는 네트워크와 수십 초가 들어 시험마다
// 돌리지 않는다. 제품 코드에는 시험용 분기가 없다. 네이티브 모듈 확인은 실제로 한다(node_modules 를 링크한다).

import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, distRoot, isPidAlive } from '../../support/proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HOST_CLI = path.join(HERE, 'fake-host-cli.mjs');
const FAKE_MCP_SERVER = path.join(HERE, 'fake-mcp-server.mjs');
const DIST_PARTS = ['entry/cli.js', 'setup', 'protocol', 'diagnostics'];

/** 시험의 처음 설정 파일. 설치가 건드리면 안 되는 값이 들어 있다. */
export const INITIAL = {
  claudeJson: {
    numStartups: 5,
    mcpServers: { other: { type: 'stdio', command: '/usr/bin/other', args: ['--flag'], env: { OTHER_TOKEN: 'do-not-print-this' } } },
    projects: {
      '/some/project': { allowedTools: ['Bash(ls:*)'], hasTrustDialogAccepted: true, mcpServers: {}, enabledMcpjsonServers: [], lastCost: 1.5 },
    },
  },
  claudeSettings: { model: 'keep-model', permissions: { allow: ['Read'], deny: [] }, hooks: { Stop: [] } },
  codexToml: [
    'notify = ["bash", "-lc", "echo done"]',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '',
    '[tui]',
    'theme = "dark"',
    '',
    '[projects."/some/project"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.other]',
    'command = "/usr/bin/other"',
    'args = ["--flag"]',
    '',
    '[mcp_servers.other.env]',
    'OTHER_TOKEN = "do-not-print-this"',
    '',
  ].join('\n'),
};

export const formatJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function writeExecutable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function hashTree(dir, skip, prefix = '') {
  const found = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (skip(full)) continue;
    if (entry.isDirectory()) for (const [key, value] of hashTree(full, skip, relative)) found.set(key, value);
    else if (entry.isFile()) found.set(relative, `${createHash('sha256').update(readFileSync(full)).digest('hex')} ${(statSync(full).mode & 0o777).toString(8)}`);
    else found.set(relative, 'not-a-file');
  }
  return found;
}

function readJsonLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/**
 * @param {object} [options]
 * @param {('claude'|'codex')[]} [options.hosts] 가짜 CLI 를 만들 호스트. 기본은 둘 다.
 * @param {boolean} [options.hostsOnPath] 참이면 CLI 를 PATH 에 두고 이름으로 찾게 한다. 기본은 AGENT_CHAT_*_BIN 으로 준다.
 * @param {string} [options.agentHome] AGENT_CHAT_HOME 으로 줄 폴더 이름. 생략하면 기본값(~/.agent-chat)을 쓴다.
 * @param {boolean} [options.build] 거짓이면 빌드 결과(dist)를 넣지 않는다.
 * @param {boolean} [options.nodeModules] 거짓이면 node_modules 를 링크하지 않는다(네이티브 확인이 실패한다).
 * @param {boolean} [options.inPlace] 참이면 저장소를 설치 위치가 아닌 다른 폴더에 둔다.
 */
export function createWorld(options = {}) {
  const hosts = options.hosts ?? ['claude', 'codex'];
  const dist = distRoot();
  if (!existsSync(path.join(dist, 'entry', 'cli.js'))) {
    throw new Error(`빌드 결과가 없다: ${dist}/entry/cli.js. 먼저 빌드한다(npx tsc -p tsconfig.json --outDir <폴더>, AGENT_CHAT_DIST=<폴더>).`);
  }
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent chat w8 ')));
  const home = path.join(root, 'home dir');
  const agentHome = options.agentHome === undefined ? path.join(home, '.agent-chat') : path.join(root, options.agentHome);
  const app = options.inPlace === true ? path.join(root, 'dev checkout') : path.join(agentHome, 'app');
  const work = path.join(root, 'work dir');
  const binDir = path.join(root, 'bin dir');
  const hostBin = path.join(root, 'host bin');
  const stateDir = path.join(root, 'fake-mcp-state');
  const hostLog = path.join(root, 'host-calls.jsonl');
  const npmLog = path.join(root, 'npm-calls.log');

  // 설치기가 쓰는 임시 폴더. 세계 전체가 시험의 임시 폴더 아래에 있으므로, 그 폴더를 그대로 주면 세계의 `bin dir/node` 링크가
  // "임시 폴더 아래의 일회용 링크"로 걸러진다(검토 2차 BOUNDARY-R2-02). 실제 사용자 환경처럼 Node 링크가 임시 폴더 밖에 있게 한다.
  const tmpDir = path.join(root, 'tmp dir');
  for (const dir of [home, path.join(home, '.claude'), path.join(home, '.codex'), work, binDir, hostBin, stateDir, app, tmpDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, '.fake-home-marker'), 'tests/e2e/install/fixture.mjs 가 만든 시험용 홈이다\n');
  writeFileSync(path.join(home, '.claude.json'), formatJson(INITIAL.claudeJson));
  writeFileSync(path.join(home, '.claude', 'settings.json'), formatJson(INITIAL.claudeSettings));
  writeFileSync(path.join(home, '.codex', 'config.toml'), INITIAL.codexToml);

  // 설치 위치에 저장소를 둔다. 커밋하지 않은 작업 트리를 복사하는 것과 같다.
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(app, 'package.json'));
  cpSync(path.join(REPO_ROOT, 'scripts'), path.join(app, 'scripts'), { recursive: true });
  mkdirSync(path.join(app, 'installer'));
  for (const name of ['install.sh', 'claude.sh', 'codex.sh']) cpSync(path.join(REPO_ROOT, 'installer', name), path.join(app, 'installer', name));
  if (options.build !== false) {
    for (const part of DIST_PARTS) cpSync(path.join(dist, part), path.join(app, 'dist', part), { recursive: true });
    cpSync(FAKE_MCP_SERVER, path.join(app, 'dist', 'entry', 'mcp.js'));
  }
  if (options.nodeModules !== false) symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir');

  symlinkSync(process.execPath, path.join(binDir, 'node'));
  writeExecutable(
    path.join(binDir, 'npm'),
    ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$FAKE_NPM_LOG"', 'if [ "${FAKE_NPM_FAIL:-}" = "$1" ]; then exit 7; fi', 'exit 0', ''].join('\n'),
  );
  const bins = {};
  for (const host of hosts) {
    bins[host] = path.join(options.hostsOnPath === true ? binDir : hostBin, host);
    writeExecutable(bins[host], `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HOST_CLI}" ${host} "$@"\n`);
  }

  const baseEnv = {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmpDir,
    FAKE_HOST_LOG: hostLog,
    FAKE_NPM_LOG: npmLog,
  };
  if (options.agentHome !== undefined) baseEnv.AGENT_CHAT_HOME = agentHome;
  if (options.hostsOnPath !== true) {
    if (bins.claude) baseEnv.AGENT_CHAT_CLAUDE_BIN = bins.claude;
    if (bins.codex) baseEnv.AGENT_CHAT_CODEX_BIN = bins.codex;
  }

  const exec = (command, args, extraEnv = {}, cwd = work) => {
    const env = { ...baseEnv };
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
    return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  const world = {
    root, home, agentHome, app, work, binDir, hostBin, stateDir, bins, baseEnv,
    mcpEntry: path.join(app, 'dist', 'entry', 'mcp.js'),
    node: process.execPath,

    /** 설치 본체를 직접 실행한다. */
    installMjs: (args = [], env = {}, cwd) => exec(process.execPath, [path.join(app, 'scripts', 'install.mjs'), ...args], env, cwd),
    /** 셸 진입점을 실행한다. script 는 install.sh, claude.sh, codex.sh. */
    shell: (script, args = [], env = {}, cwd) => exec('/bin/sh', [path.join(app, 'installer', script), ...args], env, cwd),
    /** 빌드한 CLI 를 직접 실행한다. */
    cli: (args = [], env = {}, cwd) => exec(process.execPath, [path.join(app, 'dist', 'entry', 'cli.js'), ...args], env, cwd),
    exec,

    /** 가짜 호스트 CLI 가 받은 호출. host 를 주면 그 호스트 것만. */
    hostCalls: (host) => readJsonLines(hostLog).filter((call) => host === undefined || call.host === host),
    clearHostCalls: () => rmSync(hostLog, { force: true }),
    npmCalls: () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n') : []),
    /** 가짜 MCP 서버가 띄워질 때 받은 것과, 받은 tool 호출. */
    mcpLaunches: () => readJsonLines(path.join(stateDir, 'launches.jsonl')),
    mcpCalls: () => readJsonLines(path.join(stateDir, 'calls.jsonl')),
    clearMcp: () => {
      rmSync(path.join(stateDir, 'launches.jsonl'), { force: true });
      rmSync(path.join(stateDir, 'calls.jsonl'), { force: true });
    },
    setMcpOptions: (value) => writeFileSync(path.join(stateDir, 'options.json'), JSON.stringify(value)),
    /** 띄워졌던 가짜 MCP 프로세스 가운데 아직 남은 것의 pid. */
    leftoverMcp: () => readJsonLines(path.join(stateDir, 'launches.jsonl')).map((launch) => launch.pid).filter((pid) => isPidAlive(pid)),

    claudeJsonText: () => readFileSync(path.join(home, '.claude.json'), 'utf8'),
    claudeJson: () => JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')),
    codexTomlText: () => readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'),
    /** `.claude.json` 에서 agent-chat 등록 항목만 뺀 글. 처음 파일과 바이트가 같아야 한다. */
    claudeJsonWithoutOwn: () => {
      const config = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
      delete config.mcpServers['agent-chat'];
      return formatJson(config);
    },
    /** `config.toml` 에서 [mcp_servers.agent-chat] 표(하위 표 포함)만 뺀 글. */
    codexTomlWithoutOwn: () => {
      const lines = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').split('\n');
      const start = lines.indexOf('[mcp_servers.agent-chat]');
      if (start < 0) return lines.join('\n');
      let end = start + 1;
      while (end < lines.length && (lines[end].startsWith('[mcp_servers.agent-chat.') || !lines[end].startsWith('['))) end += 1;
      if (end === lines.length && lines[end - 1] === '') end -= 1;
      lines.splice(start > 0 && lines[start - 1] === '' ? start - 1 : start, end - (start > 0 && lines[start - 1] === '' ? start - 1 : start));
      return lines.join('\n');
    },

    /** 가짜 홈의 모든 파일(경로 → 해시와 권한). 설치 뿌리(AGENT_CHAT_HOME) 아래는 뺀다. */
    homeFiles: () => hashTree(home, (full) => full === agentHome),
    /** 설치 뿌리 아래에서 app 을 뺀 파일. */
    agentHomeFiles: () => (existsSync(agentHome) ? hashTree(agentHome, (full) => full === app) : new Map()),

    cleanup: () => {
      for (const pid of world.leftoverMcp()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 이미 끝났다.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}

/** 두 파일 목록에서 달라진 경로(더해짐, 없어짐, 내용이 바뀜). */
export function changedPaths(before, after) {
  const changed = [];
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed.sort();
}
