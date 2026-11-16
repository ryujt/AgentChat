// protocol 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// Subscribable(runtime-ports.ts)의 약속을 구현마다 같은 확인으로 본다.
// 그 타입을 구현하는 세 모듈(signaling-client, mesh, inbox)의 시험이 자기 구현에 돌린다.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Unsubscribe } from './runtime-ports.js';

/** 구현 하나의 이벤트 하나를 확인에 붙이는 방법. */
export interface SubscribableProbe {
  /** 그 이벤트에 리스너를 붙인다. 구현의 `on(event, listener)` 를 그대로 부른다. */
  subscribe(listener: () => void): Unsubscribe;
  /** 그 이벤트가 한 번 나게 한다. 리스너는 이 호출이 돌아오기 전에 불려야 한다. */
  emit(): void;
}

/** 확인마다 새 구현을 받는다. 앞 확인의 리스너가 남지 않게 하려는 것이다. */
export type SubscribableProbeFactory = () => SubscribableProbe;

export interface SubscribableCheck {
  readonly name: string;
  /** 약속을 어기면 던진다. */
  run(make: SubscribableProbeFactory): void;
}

export const SUBSCRIBABLE_CHECKS: readonly SubscribableCheck[] = Object.freeze([
  {
    name: '리스너는 등록한 순서대로, 내는 호출 안에서 동기로 불린다',
    run(make: SubscribableProbeFactory): void {
      const probe = make();
      const seen: string[] = [];
      probe.subscribe(() => seen.push('a'));
      probe.subscribe(() => seen.push('b'));
      probe.subscribe(() => seen.push('c'));
      assert.deepEqual(seen, [], '내기 전에는 불리지 않는다');
      probe.emit();
      assert.deepEqual(seen, ['a', 'b', 'c']);
    },
  },
  {
    name: '한 리스너가 던져도 내는 쪽은 던지지 않고 나머지 리스너가 불린다',
    run(make: SubscribableProbeFactory): void {
      const probe = make();
      const seen: string[] = [];
      probe.subscribe(() => seen.push('a'));
      probe.subscribe(() => {
        throw new Error('listener failed');
      });
      probe.subscribe(() => seen.push('c'));
      assert.doesNotThrow(() => probe.emit());
      assert.deepEqual(seen, ['a', 'c']);
    },
  },
  {
    name: '리스너가 던진 뒤에도 다음 이벤트가 그대로 나간다',
    run(make: SubscribableProbeFactory): void {
      const probe = make();
      let count = 0;
      probe.subscribe(() => {
        throw new Error('listener failed');
      });
      probe.subscribe(() => {
        count += 1;
      });
      assert.doesNotThrow(() => probe.emit());
      assert.doesNotThrow(() => probe.emit());
      assert.equal(count, 2);
    },
  },
  {
    name: '해지하면 그 리스너만 빠진다. 여러 번 해지해도 된다',
    run(make: SubscribableProbeFactory): void {
      const probe = make();
      const seen: string[] = [];
      const offA = probe.subscribe(() => seen.push('a'));
      probe.subscribe(() => seen.push('b'));
      probe.emit();
      offA();
      assert.doesNotThrow(() => offA());
      probe.emit();
      assert.deepEqual(seen, ['a', 'b', 'b']);
    },
  },
]);

/**
 * Subscribable 적합성 시험을 등록한다. describe 안에서 부른다.
 * 예: `defineSubscribableContractTests('inbox mode-changed', () => { const inbox = …; return { subscribe: (l) => inbox.on('mode-changed', l), emit: () => … }; })`
 */
export function defineSubscribableContractTests(name: string, make: SubscribableProbeFactory): void {
  for (const check of SUBSCRIBABLE_CHECKS) {
    it(`${name}: ${check.name}`, () => {
      check.run(make);
    });
  }
}
