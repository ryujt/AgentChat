// 여러 모듈이 주입받는 실행 환경 포트의 타입 (architecture.md 2절, implementation-plan.md 1절 7번).
// 형제 모듈끼리 타입을 주고받지 않게 여기에 둔다. 이 파일에는 타입만 있다. 시계와 타이머에 닿지 않는다.

/** 현재 벽시계(epoch ms). 경과 시간도 이 값으로 잰다(protocol.md 5.5). */
export type Now = () => number;

/** 0 이상 1 미만의 무작위 수. 재접속 대기처럼 고르게 흩어야 하는 값에 쓴다. */
export type RandomUnit = () => number;

/** 타이머 손잡이. 만든 Timers 의 clearTimeout 에만 넘긴다. */
export type TimerHandle = unknown;

/**
 * 한 번 울리는 타이머. 주기 작업은 울릴 때마다 다시 건다.
 * 모듈은 전역 타이머를 직접 부르지 않는다. 그래야 시험이 시간을 움직일 수 있다.
 * node:test 의 가짜 타이머는 한 번에 움직인 구간 안에서 다시 건 타이머를 구간의 끝 시각 기준으로 건다.
 * 시험은 가장 짧은 주기 이하의 걸음으로 시간을 움직인다.
 */
export interface Timers {
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  /** 이미 울렸거나 지운 손잡이를 넘겨도 아무 일이 없다. */
  readonly clearTimeout: (handle: TimerHandle) => void;
}

export type Unsubscribe = () => void;

/**
 * 모듈이 내는 이벤트를 듣는 방법. 세 모듈(signaling-client, mesh, inbox)이 같은 모양을 쓴다.
 * - 리스너는 등록한 순서대로, 내는 쪽의 호출 안에서 동기로 불린다.
 * - 리스너가 던진 예외는 내는 모듈이 잡아 로그만 남긴다. 다른 리스너와 내는 쪽의 상태를 지킨다.
 * - 돌려받은 함수를 부르면 그 리스너만 빠진다. 여러 번 불러도 된다.
 */
export interface Subscribable<Events extends { [E in keyof Events]: (payload: never) => void }> {
  on<E extends keyof Events>(event: E, listener: Events[E]): Unsubscribe;
}
