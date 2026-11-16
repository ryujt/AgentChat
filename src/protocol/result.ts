// protocol 의 모든 해석·검증 함수가 돌려주는 결과 모양. 예외를 던지지 않기 위해 둔다.

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<C extends string = string> {
  readonly ok: false;
  readonly code: C;
  /** 사람이 읽는 짧은 사유. 피어나 사용자가 준 값의 원문을 싣지 않는다. */
  readonly detail: string;
}

export type Result<T, C extends string = string> = Ok<T> | Err<C>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<C extends string>(code: C, detail: string): Err<C> {
  return { ok: false, code, detail };
}
