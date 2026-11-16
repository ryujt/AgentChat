// 관전 명령 한 줄 만들기 (mcp-interface.md 3.4 의 room.monitor_command, architecture.md 3.11).
// 사람이 이 PC 의 콘솔에 그대로 붙여 넣어 방을 지켜보는 명령이다. 순수 함수다. 파일과 환경을 보지 않는다.

import type { MonitorLauncher } from './contract.js';

/** 셸이 따로 해석하지 않는 글자만으로 된 낱말. 방 ID 와 대부분의 서버 키가 여기에 든다. */
const SHELL_SAFE = /^[A-Za-z0-9._:/@%+=,-]+$/;

/** POSIX 셸의 작은따옴표 인용. 안의 `'` 는 `'\''` 로 바꾼다. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function shellWord(text: string): string {
  return SHELL_SAFE.test(text) ? text : shellQuote(text);
}

/** Windows 의 큰따옴표 인용. 경로에는 큰따옴표가 들 수 없다. */
function windowsWord(text: string): string {
  return /^[A-Za-z0-9._:/\\@%+=,-]+$/.test(text) ? text : `"${text.replace(/"/g, '')}"`;
}

/**
 * - sh: `sh '<경로>/scripts/monitor.sh' <room_id> <server>`. 경로는 늘 작은따옴표로 감싼다(공백이 든 설치 경로).
 * - node: `node "<경로>\dist\entry\monitor.js" <room_id> <server>`.
 * 진입점을 모르면 null.
 */
export function monitorCommand(launcher: MonitorLauncher | null | undefined, roomId: string, serverKey: string): string | null {
  if (launcher === null || launcher === undefined) return null;
  if (launcher.kind === 'sh') return `sh ${shellQuote(launcher.path)} ${shellWord(roomId)} ${shellWord(serverKey)}`;
  return `node "${launcher.path.replace(/"/g, '')}" ${windowsWord(roomId)} ${windowsWord(serverKey)}`;
}
