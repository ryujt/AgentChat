// 등록된 명령과 환경 그대로 MCP 프로세스를 띄우는 유일한 파일 (architecture.md 3.13).
// SDK 의 클라이언트 stdio 전송은 프로세스를 띄운다. 여기서는 등록에서 읽은 명령·인자·환경만 넘긴다.
// 호스트 CLI 나 다른 실행 파일을 고르는 판단을 여기에 두지 않는다.

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** 등록에서 읽은 실행 정보. */
export interface McpLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface McpProcess {
  readonly transport: Transport;
  /** 띄운 뒤의 pid. 아직 띄우지 않았으면 null. */
  pid(): number | null;
  /** 띄운 프로세스가 아직 있는가. */
  alive(): boolean;
  /** 남아 있으면 강제로 끝낸다. 정리의 마지막 수단이다. */
  kill(): void;
  /** 프로세스가 stderr 에 쓴 글의 끝부분. 뜨지 못한 이유를 보여 줄 때 쓴다. */
  stderrTail(): string;
}

export type LaunchMcp = (spec: McpLaunchSpec) => McpProcess;

const STDERR_TAIL_CHARS = 2000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EPERM';
  }
}

export const launchMcpProcess: LaunchMcp = (spec) => {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...spec.args],
    env: { ...spec.env },
    stderr: 'pipe',
  });
  const seen: { pid: number | null; stderr: string } = { pid: null, stderr: '' };
  transport.stderr?.on('data', (chunk: unknown) => {
    seen.stderr = `${seen.stderr}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
  });
  const pid = (): number | null => {
    // 전송은 닫히면 pid 를 잊는다. 남은 프로세스를 확인하려면 본 값을 갖고 있어야 한다.
    seen.pid = transport.pid ?? seen.pid;
    return seen.pid;
  };
  return {
    transport,
    pid,
    alive: () => {
      const current = pid();
      return current !== null && isAlive(current);
    },
    kill: () => {
      const current = pid();
      if (current === null) return;
      try {
        process.kill(current, 'SIGKILL');
      } catch {
        // 이미 끝났다.
      }
    },
    stderrTail: () => seen.stderr,
  };
};
