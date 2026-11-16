// 참가자 표시(shown_as) 계산 (mcp-interface.md 3.4 의 표). 입력만 보는 순수 함수다.
// 상태를 갖지 않는다. 다른 부분을 부르지 않는다.

import type { PresenceStatus } from '../protocol/index.js';
import type { ShownAs } from './contract.js';

export interface ShownAsInput {
  /** 동기화까지 끝난 링크가 지금 있는가(LinkStatus 의 open). */
  readonly linkOpen: boolean;
  /** presence 를 아직 못 받았으면 null. */
  readonly status: PresenceStatus | null;
  readonly listening: boolean | null;
  /** 서버가 가장 최근에 준 참가자 목록에 있는가. */
  readonly inServerList: boolean;
  /** 연결 시도가 UNREACHABLE_AFTER_FAILS 회 이상 연속 실패했는가. */
  readonly failedRepeatedly: boolean;
  /** P2P 버전이 달라 링크를 닫았는가. */
  readonly versionMismatch: boolean;
  /** 마지막 링크가 bye{leave|shutdown} 으로 닫혔고 그 뒤 새 시도가 없는가. */
  readonly leftByBye: boolean;
  /** 이 세션에서 그 참가자와 링크가 열린(동기화된) 적이 있는가. */
  readonly everLinked: boolean;
}

/**
 * 표를 위에서부터 처음 맞는 행으로 정한다. 마지막 행이 나머지를 모두 받는다.
 * 링크가 열려 있지 않으면 어떤 입력에서도 ready·working·not_ready 가 나오지 않는다.
 */
export function shownAs(input: ShownAsInput): ShownAs {
  if (input.linkOpen) {
    if (input.status === 'ready' && input.listening === true) return 'ready'; // 1
    if (input.status === 'working') return 'working'; // 2
    return 'not_ready'; // 3
  }
  if (input.inServerList && (input.failedRepeatedly || input.versionMismatch)) return 'unreachable'; // 4
  if (input.leftByBye) return 'left'; // 5
  if (!input.everLinked && input.inServerList) return 'connecting'; // 6
  if (!input.everLinked && !input.inServerList && input.status === 'left') return 'left'; // 7
  return 'disconnected'; // 8
}

/** create 결과에 싣는 자기 행의 표시. 자기 status 로만 정한다. */
export function selfShownAs(status: PresenceStatus | null): ShownAs {
  if (status === 'ready') return 'ready';
  if (status === 'working') return 'working';
  return 'not_ready';
}
