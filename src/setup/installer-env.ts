// 설치기가 읽는 환경 변수 (architecture.md 3.13 "설치기가 읽는 환경 변수").
// 값은 설치를 실행한 환경에서 읽는다. MCP 등록에는 넣지 않는다.
// 예외는 AGENT_CHAT_HOME 이다. 기본값(~/.agent-chat)이 아니면 등록에도 넣는다(registration.ts). MCP 프로세스가 같은 곳에 쓰게 하려는 것이다.

import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { geminiSettingsPaths, type GeminiSettingsPaths } from './gemini-config.js';
import type { HostKind } from './types.js';

export type EnvMap = Readonly<Record<string, string | undefined>>;

export interface HostBin {
  /** 실행할 이름 또는 경로. */
  readonly value: string;
  /** 사용자가 환경 변수로 줬는가. 줬는데 실행할 수 없으면 건너뛰지 않고 실패다. */
  readonly explicit: boolean;
}

export interface InstallerEnv {
  /** 설치 뿌리(`AGENT_CHAT_HOME`, 기본 `~/.agent-chat`). 절대 경로다. */
  readonly home: string;
  /** home 이 기본값(`~/.agent-chat`)과 같은가. 다르면 MCP 등록의 환경에 AGENT_CHAT_HOME 을 넣는다. */
  readonly homeIsDefault: boolean;
  readonly bins: Readonly<Record<HostKind, HostBin>>;
  /** `doctor` 가 쓸 서버 주소. 없으면 null(등록된 환경 또는 공용 서버). */
  readonly server: string | null;
  /** Channels 를 막는 공급자 변수 가운데 설정된 것의 이름. */
  readonly providerFlags: readonly string[];
  /** Codex 설정 파일. Codex 가 `CODEX_HOME` 을 따르므로 같은 규칙으로 찾는다. */
  readonly codexConfigPath: string;
  /** Gemini CLI 설정 파일(사용자 `~/.gemini/settings.json`, 작업 폴더의 `.gemini/settings.json`). 등록을 여기서 읽는다. */
  readonly geminiSettings: GeminiSettingsPaths;
  /**
   * 설치를 실행한 작업 폴더. 호스트 CLI 는 이 폴더에서 실행되고 그 폴더의 등록(Claude Code 의 local·project 범위, Codex 의 프로젝트 설정)을 함께 본다.
   * Codex 의 프로젝트 설정에 같은 이름의 등록이 있는지 찾을 때 쓴다(검토 3차 BOUNDARY-R3-02).
   */
  readonly cwd: string;
}

const PROVIDER_FLAGS: readonly string[] = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

function given(env: EnvMap, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === '' ? null : value;
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function readInstallerEnv(env: EnvMap, userHome: string, cwd: string): InstallerEnv {
  const home = given(env, 'AGENT_CHAT_HOME');
  const claude = given(env, 'AGENT_CHAT_CLAUDE_BIN');
  const codex = given(env, 'AGENT_CHAT_CODEX_BIN');
  const gemini = given(env, 'AGENT_CHAT_GEMINI_BIN');
  const codexHome = given(env, 'CODEX_HOME');
  const defaultHome = join(userHome, '.agent-chat');
  const resolvedHome = home === null ? defaultHome : absolute(home, cwd);
  return {
    home: resolvedHome,
    homeIsDefault: resolve(resolvedHome) === resolve(defaultHome),
    bins: {
      claude: { value: claude ?? 'claude', explicit: claude !== null },
      codex: { value: codex ?? 'codex', explicit: codex !== null },
      gemini: { value: gemini ?? 'gemini', explicit: gemini !== null },
    },
    server: given(env, 'AGENT_CHAT_SERVER'),
    providerFlags: PROVIDER_FLAGS.filter((name) => given(env, name) !== null),
    codexConfigPath: join(codexHome === null ? join(userHome, '.codex') : absolute(codexHome, cwd), 'config.toml'),
    geminiSettings: geminiSettingsPaths(userHome, cwd),
    cwd,
  };
}

/** 셸 세션마다 만들어지고 세션이 끝나면 지워지는 링크 폴더의 이름(fnm). */
const TRANSIENT_DIR_NAMES: readonly string[] = ['fnm_multishells'];

/**
 * 일회용 링크를 둘 만한 뿌리 폴더: 임시 폴더(os.tmpdir())와 `XDG_RUNTIME_DIR`(로그아웃하면 비워진다). 비었거나 없는 값은 뺀다.
 * fnm 은 셸마다 `$XDG_RUNTIME_DIR/fnm_multishells/<pid>_<시각>/bin`(macOS 는 캐시 폴더)을 PATH 앞에 둔다.
 */
export function transientNodeRoots(env: EnvMap, tmpDir: string): string[] {
  return [tmpDir, env['XDG_RUNTIME_DIR'] ?? ''].map((root) => root.trim()).filter((root) => root !== '' && isAbsolute(root));
}

function isUnder(path: string, root: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(base);
}

/** 셸 세션이 끝나거나 재부팅·캐시 정리로 지워지는 링크인가. 링크 경로와 뿌리 폴더를 실경로로도 견준다. */
function isTransientLink(candidate: string, roots: readonly string[], realpath: (path: string) => string): boolean {
  if (candidate.split(sep).some((part) => TRANSIENT_DIR_NAMES.includes(part))) return true;
  const real = (path: string): string | null => {
    try {
      return realpath(path);
    } catch {
      return null;
    }
  };
  const forms = (path: string): string[] => [path, real(path)].filter((form): form is string => form !== null);
  const linkDirs = forms(dirname(candidate));
  return roots.some((root) => forms(root).some((form) => linkDirs.some((dir) => dir === form || isUnder(dir, form))));
}

export interface NodePathChoice {
  /** MCP 등록의 명령이 될 Node 경로. */
  readonly path: string;
  /** 셸이 찾은 경로를 쓰지 않았거나 링크를 그대로 썼을 때의 설명(설치 출력 단계 8). 알릴 것이 없으면 null. */
  readonly note: string | null;
}

/**
 * MCP 등록의 명령이 될 Node 경로 (architecture.md 3.13, 검토 1차 BOUNDARY-R1-02, 검토 2차 BOUNDARY-R2-02).
 * 셸 진입점은 찾은 Node 의 경로(`command -v` 의 결과. 링크일 수 있다)를 `AGENT_CHAT_INSTALL_NODE` 로 넘긴다.
 * 그 경로가 지금 실행 중인 Node(process.execPath, 링크를 푼 경로)와 같은 파일이면 그 경로를 그대로 쓴다.
 * brew 의 `/opt/homebrew/bin/node` 처럼 버전마다 바뀌지 않는 링크를 등록해야 `brew upgrade` 뒤에도 등록이 깨지지 않는다.
 * 다만 셸 세션마다 만드는 일회용 링크(fnm_multishells, 임시 폴더나 XDG_RUNTIME_DIR 아래)는 세션이 끝나면 지워져 등록이 ENOENT 로 깨지므로 쓰지 않는다.
 * 주지 않았거나(`node scripts/install.mjs` 를 직접 실행), 다른 Node 거나, 풀 수 없거나, 일회용 링크면 process.execPath 를 쓴다.
 */
export function chooseNodePath(
  given: string | undefined,
  execPath: string,
  realpath: (path: string) => string,
  cwd: string,
  transientRoots: readonly string[] = [],
): NodePathChoice {
  if (given === undefined || given.trim() === '') return { path: execPath, note: null };
  const candidate = absolute(given, cwd);
  if (candidate === execPath) return { path: execPath, note: null };
  let same: boolean;
  try {
    same = realpath(candidate) === realpath(execPath);
  } catch {
    return { path: execPath, note: `셸이 찾은 ${candidate} 를 풀 수 없어 설치를 실행한 Node 의 실경로를 등록했다` };
  }
  if (!same) {
    return { path: execPath, note: `셸이 찾은 ${candidate} 는 설치를 실행한 Node 와 다른 파일이라(버전 관리 도구의 shim 등) 그 Node 의 실경로를 등록했다` };
  }
  if (isTransientLink(candidate, transientRoots, realpath)) {
    return { path: execPath, note: `셸이 찾은 ${candidate} 는 셸 세션이 끝나거나 재부팅하면 지워지는 링크라 쓰지 않았다. Node 버전을 지우면 다시 설치한다` };
  }
  return { path: candidate, note: `셸이 찾은 링크 그대로다(실경로 ${execPath}). Node 를 업그레이드해도 이 경로가 새 Node 를 가리키면 등록이 그대로다` };
}

/** chooseNodePath 의 경로만. */
export function registeredNodePath(
  given: string | undefined,
  execPath: string,
  realpath: (path: string) => string,
  cwd: string,
  transientRoots: readonly string[] = [],
): string {
  return chooseNodePath(given, execPath, realpath, cwd, transientRoots).path;
}
