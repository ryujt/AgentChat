// mcp-server 의 내부 값과 tool 입력 상한 (architecture.md 5절, mcp-interface.md 3절).

import type { DefaultMcpServerLimits, ToolInputLimits } from './contract.js';

export const DEFAULT_MCP_SERVER_LIMITS: DefaultMcpServerLimits = Object.freeze({
  SHUTDOWN_BUDGET_MS: 400,
});

export const TOOL_INPUT_LIMITS: ToolInputLimits = Object.freeze({
  ROLE_MAX_CHARS: 64,
  TOOLS_MAX_ITEMS: 20,
  TOOL_ITEM_MAX_CHARS: 64,
  NOTE_MAX_CHARS: 200,
  STOP_REASON_MAX_CHARS: 200,
  SCENARIO_TITLE_MAX_CHARS: 200,
  TEST_DURATION_MIN: Object.freeze({ min: 1, max: 480, default: 60 }),
  TEST_SCENARIOS: Object.freeze({ min: 1, max: 100, default: 20 }),
  WAIT_MAX_SEC: Object.freeze({ min: 5, max: 540, default: 50 }),
});
