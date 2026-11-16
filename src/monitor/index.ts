// monitor 모듈의 공개 진입점. 계약은 contract.ts, 규칙은 docs/design/architecture.md 3.14 에 있다.
// 조립(entry/monitor)은 이 파일과 contract.ts 만 import 한다.

export { MONITOR_USAGE, parseMonitorArgs } from './args.js';
export { displayWidth, formatEvent, formatNotice, formatSnapshot, jsonLine, liveHeader, toTerminalText } from './format.js';
export { MONITOR_POLL_MS, MONITOR_SHUTDOWN_BUDGET_MS, exitCodeOf, failureText, runMonitor } from './run.js';
export { MONITOR_HOLD_MAX, createMonitorSink, eventLine } from './sink.js';
export { INPUT_HELP, createLineSplitter, parseChatInput } from './input.js';
export type * from './contract.js';
