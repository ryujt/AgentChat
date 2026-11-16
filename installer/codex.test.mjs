// V-L10 (나): 셸 진입점 installer/codex.sh (Codex 전용). Claude Code 를 등록하지 않는다.
// 실행: 빌드한 뒤 `node --test installer/*.test.mjs` (묶음별 빌드 폴더를 쓰면 AGENT_CHAT_DIST=<폴더>).

import { defineShellTests } from '../tests/e2e/install/shell-cases.mjs';

defineShellTests('codex.sh', ['codex']);
