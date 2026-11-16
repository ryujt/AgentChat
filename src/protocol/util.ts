// protocol 안에서만 쓰는 작은 도구. index.ts 는 utf8ByteLength 만 내보낸다.

import type { z } from 'zod';

/** 와이어 상한은 모두 UTF-8 바이트 기준이다. 문자열 길이(UTF-16)와 다르다. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 공개 표(이름 목록, 오류 표)를 안쪽까지 얼린다.
 * 실행 중에 바뀌면 해석 함수가 표와 어긋나고, 모듈 수준의 값이 가변 상태가 된다.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

export type JsonParse = { ok: true; value: unknown } | { ok: false };

export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * 스키마 위반을 "경로: 종류"로만 요약한다.
 * zod 의 기본 문구에는 받은 값이 섞일 수 있어, 이 모듈이 쓴 문구(custom)만 그대로 싣는다.
 */
export function describeIssues(error: z.ZodError, limit = 3): string {
  const parts = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    const what = issue.code === 'custom' ? issue.message : issue.code;
    return `${path}: ${what}`;
  });
  const more = error.issues.length - parts.length;
  return more > 0 ? `${parts.join('; ')}; +${more} more` : parts.join('; ');
}
