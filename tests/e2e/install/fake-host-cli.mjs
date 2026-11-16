// 시험 전용: 가짜 호스트 CLI. `node fake-host-cli.mjs <claude|codex> <인자…>` 로 실행한다.
// 실제 CLI(Claude Code 2.1.325, Codex 0.169.0)의 하위 명령과 출력 모양을 흉내 낸다.
// 등록은 실제 CLI 와 같은 파일에 쓴다: Claude Code 는 $HOME/.claude.json, Codex 는 $HOME/.codex/config.toml.
// 실제 사용자 홈을 건드리지 않게, HOME 이 시험용 임시 폴더일 때만 쓴다.
//
// 동작을 바꾸는 환경 변수 (시험이 준다):
//   FAKE_HOST_LOG         받은 인자를 JSON 한 줄씩 적는 파일
//   FAKE_CLAUDE_VERSION   `claude --version` 의 출력 (기본값: 2.1.325 (Claude Code))
//   FAKE_CODEX_VERSION    `codex --version` 의 출력 (기본값: codex-cli 0.169.0)
//   FAKE_CLAUDE_AUTH      `claude auth status` 의 출력. fail 이면 읽을 수 없는 출력과 종료 코드 1
//   FAKE_CODEX_CONFIG     Codex 가 등록을 쓰는 파일 (기본값: ${CODEX_HOME:-$HOME/.codex}/config.toml)
//   FAKE_FAIL_ADD         claude 또는 codex 면 그 호스트의 `mcp add` 가 실패한다
//   FAKE_CODEX_LIKE_0169  상태 파일 경로. 주면 실제 Codex 0.169.0 에서 본 두 동작을 흉내 낸다(2026-11-16 V-S1 S-FI-01).
//                         (가) `mcp get`·`list --json` 의 env 키 순서가 부를 때마다 바뀐다(상태 파일에 호출 횟수를 센다).
//                         (나) `mcp add`·`remove` 가 설정 파일을 다시 쓰면서 다른 서버 표의 표기를 바꾼다:
//                              `args = []` 줄을 지우고, `*_timeout_sec` 정수를 소수(`30` → `30.0`)로, 배열의 공백을 `["a", "b"]` 꼴로.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NAME = 'agent-chat';
const [host, ...args] = process.argv.slice(2);
const home = process.env.HOME ?? '';

function finish(code, stdout = '', stderr = '') {
  if (stdout !== '') process.stdout.write(stdout);
  if (stderr !== '') process.stderr.write(stderr);
  process.exit(code);
}

if (home === '' || !existsSync(path.join(home, '.fake-home-marker'))) {
  // 실제 홈에서 잘못 불렸을 때 아무 것도 쓰지 않는다.
  finish(97, '', 'fake-host-cli: HOME 이 시험용 홈이 아니다\n');
}

if (process.env.FAKE_HOST_LOG) {
  appendFileSync(process.env.FAKE_HOST_LOG, `${JSON.stringify({ host, args, cwd: process.cwd() })}\n`);
}

/** `mcp add … (플래그 KEY=VALUE)* -- 명령 인자…` 에서 등록 내용을 읽는다. */
function parseAdd(envFlag) {
  const split = args.indexOf('--');
  const env = {};
  for (let index = 0; index < split; index += 1) {
    if (args[index] !== envFlag) continue;
    const pair = args[index + 1] ?? '';
    env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  }
  return { command: args[split + 1] ?? '', args: args.slice(split + 2), env };
}

// ── Claude Code ─────────────────────────────────────────────────────────────

const claudeFile = path.join(home, '.claude.json');
const readClaude = () => (existsSync(claudeFile) ? JSON.parse(readFileSync(claudeFile, 'utf8')) : {});
/** 시험의 처음 파일과 같은 서식으로 쓴다. 등록을 지우면 처음 바이트로 돌아간다. */
const writeClaude = (config) => writeFileSync(claudeFile, `${JSON.stringify(config, null, 2)}\n`);

const SCOPE_LABEL = {
  user: 'User config (available in all your projects)',
  local: 'Local config (private to you in this project)',
};

function claude() {
  if (args.length === 1 && args[0] === '--version') finish(0, `${process.env.FAKE_CLAUDE_VERSION ?? '2.1.325 (Claude Code)'}\n`);
  if (args[0] === 'auth' && args[1] === 'status') {
    const auth = process.env.FAKE_CLAUDE_AUTH;
    if (auth === 'fail') finish(1, 'Not logged in\n');
    finish(0, `${auth ?? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })}\n`);
  }
  if (args[0] !== 'mcp') finish(64, '', `fake claude: 모르는 명령: ${args.join(' ')}\n`);
  const config = readClaude();
  const local = config.projects?.[process.cwd()]?.mcpServers?.[NAME];
  const user = config.mcpServers?.[NAME];

  if (args[1] === 'get' && args[2] === NAME) {
    const scope = local !== undefined ? 'local' : user !== undefined ? 'user' : null;
    if (scope === null) finish(1, '', `No MCP server named "${NAME}". Configured servers: ${Object.keys(config.mcpServers ?? {}).join(', ')}\n`);
    const server = scope === 'local' ? local : user;
    finish(
      0,
      [
        `${NAME}:`,
        `  Scope: ${SCOPE_LABEL[scope]}`,
        '  Status: ✔ Connected',
        '  Type: stdio',
        `  Command: ${server.command}`,
        `  Args: ${(server.args ?? []).join(' ')}`,
        '  Environment:',
        ...Object.entries(server.env ?? {}).map(([key, value]) => `    ${key}=${value}`),
        '',
        `To remove this server, run: claude mcp remove ${NAME} -s ${scope}`,
        '',
      ].join('\n'),
    );
  }
  if (args[1] === 'add' && args[2] === '--scope' && args[3] === 'user' && args[4] === NAME) {
    if (process.env.FAKE_FAIL_ADD === 'claude') finish(1, '', 'fake claude: add failed\n');
    if (user !== undefined) finish(1, '', `MCP server ${NAME} already exists in user config\n`);
    const added = parseAdd('-e');
    config.mcpServers = { ...config.mcpServers, [NAME]: { type: 'stdio', ...added } };
    writeClaude(config);
    finish(0, `Added stdio MCP server ${NAME} with command: ${added.command} ${added.args.join(' ')} to user config\nFile modified: ${claudeFile}\n`);
  }
  if (args[1] === 'remove' && args[2] === '--scope' && args[3] === 'user' && args[4] === NAME) {
    if (user === undefined) finish(1, '', `No user-scoped MCP server found with name: ${NAME}\n`);
    delete config.mcpServers[NAME];
    writeClaude(config);
    finish(0, `Removed MCP server ${NAME} from user config\nFile modified: ${claudeFile}\n`);
  }
  finish(64, '', `fake claude: 모르는 명령: ${args.join(' ')}\n`);
}

// ── Codex ───────────────────────────────────────────────────────────────────

const codexFile = process.env.FAKE_CODEX_CONFIG ?? path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml');
const readCodex = () => (existsSync(codexFile) ? readFileSync(codexFile, 'utf8') : '');

/** 설정 글에서 `[mcp_servers.<이름>]` 표들을 읽는다. 값은 JSON 과 같은 꼴(문자열, 문자열 배열, 수)만 다룬다. */
function codexServers(text) {
  const servers = new Map();
  let current = null;
  let inEnv = false;
  for (const line of text.split('\n')) {
    const header = /^\[mcp_servers\.([A-Za-z0-9_-]+)(\.env)?\]$/.exec(line);
    if (header !== null) {
      if (header[2] === undefined) servers.set(header[1], { command: '', args: [], env: {}, tool_timeout_sec: null });
      current = servers.get(header[1]) ?? null;
      inEnv = header[2] !== undefined;
      continue;
    }
    if (line.startsWith('[')) current = null;
    const pair = /^([A-Za-z0-9_]+) = (.*)$/.exec(line);
    if (current === null || pair === null) continue;
    const value = JSON.parse(pair[2]);
    if (inEnv) current.env[pair[1]] = value;
    else if (pair[1] in current) current[pair[1]] = value;
  }
  return servers;
}

const like0169 = process.env.FAKE_CODEX_LIKE_0169 ?? '';

/**
 * (가) env 키 순서: 호출마다 다음 순열로 낸다(상태 파일에 호출 횟수를 센다). 키가 넷이면 24번 부를 때까지 같은 순서가 다시 나오지 않는다.
 * 실제 Codex 는 무작위지만, 시험이 우연히 통과하지 않게 정해진 순서로 바꾼다.
 */
function envInCallOrder(env) {
  if (like0169 === '') return env;
  const count = existsSync(like0169) ? Number(readFileSync(like0169, 'utf8')) || 0 : 0;
  writeFileSync(like0169, String(count + 1));
  const pool = Object.keys(env);
  const ordered = [];
  let rest = count;
  while (pool.length > 0) {
    let size = 1;
    for (let n = 2; n < pool.length; n += 1) size *= n;
    const index = Math.floor(rest / size) % pool.length;
    rest %= size;
    ordered.push(pool.splice(index, 1)[0]);
  }
  return Object.fromEntries(ordered.map((key) => [key, env[key]]));
}

/** (나) 다른 서버 표의 표기를 실제 Codex 0.169.0 처럼 바꿔 쓴다. 뜻(Codex 가 읽는 값)은 같다. */
function rewriteOtherServers(text) {
  if (like0169 === '') return text;
  let inOther = false;
  const out = [];
  for (const line of text.split('\n')) {
    const header = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (line.startsWith('[')) inOther = header !== null && header[1] !== NAME;
    if (inOther && /^args = \[\s*\]$/.test(line)) continue;
    const timeout = /^((?:startup|tool)_timeout_sec) = (\d+)$/.exec(line);
    if (inOther && timeout !== null) {
      out.push(`${timeout[1]} = ${timeout[2]}.0`);
      continue;
    }
    const array = /^args = (\[.*\])$/.exec(line);
    if (inOther && array !== null) {
      out.push(`args = [${JSON.parse(array[1]).map((item) => JSON.stringify(item)).join(', ')}]`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function codexJson(name, server) {
  return {
    name,
    enabled: true,
    disabled_reason: null,
    transport: { type: 'stdio', command: server.command, args: server.args, env: Object.keys(server.env).length > 0 ? envInCallOrder(server.env) : null, env_vars: [], cwd: null },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: server.tool_timeout_sec,
  };
}

function removeCodexServer(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(`[mcp_servers.${NAME}]`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === `[mcp_servers.${NAME}.env]` || !lines[end].startsWith('['))) end += 1;
  // 파일 끝의 줄바꿈은 남긴다. 등록하기 전의 바이트로 돌아가야 한다.
  if (end === lines.length && lines[end - 1] === '') end -= 1;
  const from = start > 0 && lines[start - 1] === '' ? start - 1 : start;
  lines.splice(from, end - from);
  return lines.join('\n');
}

function codex() {
  if (args.length === 1 && args[0] === '--version') finish(0, `${process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.169.0'}\n`);
  if (args[0] !== 'mcp') finish(64, '', `fake codex: 모르는 명령: ${args.join(' ')}\n`);
  const text = readCodex();
  const servers = codexServers(text);
  const own = servers.get(NAME);

  if (args[1] === 'list' && args[2] === '--json') {
    finish(0, `${JSON.stringify([...servers.entries()].map(([name, server]) => codexJson(name, server)), null, 2)}\n`);
  }
  if (args[1] === 'get' && args[2] === NAME && args[3] === '--json') {
    if (own === undefined) finish(1, '', `Error: No MCP server named '${NAME}' found.\n`);
    finish(0, `${JSON.stringify(codexJson(NAME, own), null, 2)}\n`);
  }
  if (args[1] === 'add' && args[2] === NAME) {
    if (process.env.FAKE_FAIL_ADD === 'codex') finish(1, '', 'fake codex: add failed\n');
    const added = parseAdd('--env');
    const base = rewriteOtherServers(own === undefined ? text : removeCodexServer(text));
    const block = [
      `[mcp_servers.${NAME}]`,
      `command = ${JSON.stringify(added.command)}`,
      `args = ${JSON.stringify(added.args)}`,
      '',
      `[mcp_servers.${NAME}.env]`,
      ...Object.entries(added.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
      '',
    ];
    mkdirSync(path.dirname(codexFile), { recursive: true });
    writeFileSync(codexFile, `${base}${base === '' ? '' : '\n'}${block.join('\n')}`);
    finish(0, `Added global MCP server '${NAME}'.\n`);
  }
  if (args[1] === 'remove' && args[2] === NAME) {
    if (own === undefined) finish(0, `No MCP server named '${NAME}' found.\n`);
    writeFileSync(codexFile, rewriteOtherServers(removeCodexServer(text)));
    finish(0, `Removed global MCP server '${NAME}'.\n`);
  }
  finish(64, '', `fake codex: 모르는 명령: ${args.join(' ')}\n`);
}

if (host === 'claude') claude();
else if (host === 'codex') codex();
else finish(64, '', 'fake-host-cli: 첫 인자는 claude 또는 codex 다\n');
