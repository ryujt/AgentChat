// 연결 시도가 열리지 못했을 때의 실패 분류 (protocol.md 3.3).
// mesh(signaling·ice 단계), room-session(session 단계), tool 오류의 details 가 같은 값을 쓴다.

/**
 * - signaling: 상대가 연결 요청에 답하지 않았다. 직접 경로가 없다는 뜻이 아니다.
 *   상대 프로세스가 멈췄거나, 유령 기록이거나, 시그널이 거듭 사라진 것이다.
 * - ice: offer 와 answer 는 오갔지만 직접 경로를 찾지 못했다. 직접 연결이 안 된다고 볼 수 있는 단계다.
 * - session: 채널은 열렸지만 P2P 절차가 끝나지 않았다.
 */
export const LINK_FAILURE_REASONS = Object.freeze({
  signaling: Object.freeze([
    /** offer-request 를 다시 보냈는데도 offer 가 오지 않았다. */
    'no_offer',
    /** offer 를 다시 보냈는데도 answer 가 오지 않았다. */
    'no_answer',
    /** 서버가 PEER_NOT_FOUND 를 돌려줬다. 연속 실패로 세지 않는다. */
    'peer_gone',
  ] as const),
  ice: Object.freeze([
    /** 기한 안에 채널이 열리지 않았다. */
    'ice_timeout',
    /** pc 상태가 failed 또는 closed 가 됐다. */
    'failed',
  ] as const),
  session: Object.freeze(['hello_timeout', 'hello_mismatch', 'version', 'sync_timeout'] as const),
});

export type LinkFailureStage = keyof typeof LINK_FAILURE_REASONS;

export type LinkFailureReason<S extends LinkFailureStage = LinkFailureStage> =
  (typeof LINK_FAILURE_REASONS)[S][number];

/** 단계와 그 단계에서 나올 수 있는 사유의 짝. */
export type LinkFailure = {
  [S in LinkFailureStage]: { readonly stage: S; readonly reason: LinkFailureReason<S> };
}[LinkFailureStage];

export const LINK_FAILURE_STAGES = Object.freeze(Object.keys(LINK_FAILURE_REASONS)) as readonly LinkFailureStage[];

export function isLinkFailure(stage: unknown, reason: unknown): boolean {
  if (typeof stage !== 'string' || typeof reason !== 'string') return false;
  if (!Object.hasOwn(LINK_FAILURE_REASONS, stage)) return false;
  return (LINK_FAILURE_REASONS[stage as LinkFailureStage] as readonly string[]).includes(reason);
}
