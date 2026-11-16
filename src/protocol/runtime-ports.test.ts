// 이 파일이 보는 것은 둘이다. 제품 구현을 시험하지 않는다.
// 1. 시험 도구의 동작: node:test 의 가짜 타이머가 Timers 포트 모양의 타이머를 어떻게 움직이는가.
// 2. 적합성 시험 자체: protocol/testing.ts 의 Subscribable 확인이 약속을 어긴 구현을 잡는가.
// Subscribable 을 구현하는 모듈(signaling-client, mesh, inbox)은 같은 확인을 자기 구현에 돌린다.

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Now, TimerHandle, Timers, Unsubscribe } from './index.js';
import {
  SUBSCRIBABLE_CHECKS,
  defineSubscribableContractTests,
  type SubscribableProbe,
  type SubscribableProbeFactory,
} from './testing.js';

// 조립(entry)이 만들 실제 포트와 같은 모양. 전역을 부를 때 찾으므로 가짜 타이머가 끼어들 수 있다.
const systemTimers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
const systemNow: Now = () => Date.now();

describe('시험 도구 동작: node:test 가짜 타이머와 Timers 포트', () => {
  it('Timers 는 node:test 의 가짜 타이머로 움직일 수 있다', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    try {
      const fired: number[] = [];
      systemTimers.setTimeout(() => fired.push(systemNow()), 500);
      const cancelled: TimerHandle = systemTimers.setTimeout(() => fired.push(-1), 700);
      systemTimers.clearTimeout(cancelled);

      mock.timers.tick(499);
      assert.deepEqual(fired, []);
      mock.timers.tick(1);
      assert.deepEqual(fired, [1_500]);
      mock.timers.tick(1_000);
      assert.deepEqual(fired, [1_500]);

      // 이미 울린 손잡이와 지운 손잡이를 다시 지워도 아무 일이 없다.
      assert.doesNotThrow(() => systemTimers.clearTimeout(cancelled));
    } finally {
      mock.timers.reset();
    }
  });

  it('주기 작업은 울릴 때마다 다시 걸어 만든다 (가짜 타이머는 주기 이하로 잘게 움직인다)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      const firedAt: number[] = [];
      let handle: TimerHandle = null;
      const arm = (): void => {
        handle = systemTimers.setTimeout(() => {
          firedAt.push(systemNow());
          if (firedAt.length < 3) arm();
        }, 100);
      };
      arm();
      // 한 번에 크게 움직이면 콜백 안에서 다시 건 타이머가 "움직임이 끝난 시각"을 기준으로 걸려 밀린다.
      // 그래서 시험은 가장 짧은 주기 이하의 걸음으로 시간을 움직인다.
      for (let step = 0; step < 10; step += 1) mock.timers.tick(50);
      assert.deepEqual(firedAt, [100, 200, 300]);
      systemTimers.clearTimeout(handle);
    } finally {
      mock.timers.reset();
    }
  });
});

// ── 적합성 시험의 자체 확인 ─────────────────────────────────────────────────

type Listener = () => void;

/** 약속을 지키는 가장 작은 구현. */
function conforming(): SubscribableProbe {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener): Unsubscribe {
      // 같은 함수를 두 번 붙여도 따로 빠지게 감싼다.
      const entry: Listener = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    emit(): void {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // 내는 모듈은 여기서 로그만 남긴다.
        }
      }
    },
  };
}

/** 약속을 하나씩 어긴 구현. */
const broken: Readonly<Record<string, SubscribableProbeFactory>> = {
  '나중에 붙인 리스너부터 부른다': () => {
    const listeners: Listener[] = [];
    return {
      subscribe(listener) {
        listeners.unshift(listener);
        return () => {
          const at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
      emit() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // 무시
          }
        }
      },
    };
  },
  '리스너를 다음 마이크로태스크에 부른다': () => {
    const listeners = new Set<Listener>();
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      emit() {
        for (const listener of [...listeners]) {
          void Promise.resolve().then(() => {
            try {
              listener();
            } catch {
              // 무시
            }
          });
        }
      },
    };
  },
  '리스너의 예외를 그대로 던진다': () => {
    const listeners = new Set<Listener>();
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      emit() {
        for (const listener of [...listeners]) listener();
      },
    };
  },
  '예외를 삼키지만 남은 리스너를 부르지 않는다': () => {
    const listeners = new Set<Listener>();
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      emit() {
        try {
          for (const listener of [...listeners]) listener();
        } catch {
          // 무시
        }
      },
    };
  },
  '리스너가 던지면 그 뒤로 이벤트를 내지 않는다': () => {
    const listeners = new Set<Listener>();
    let dead = false;
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      emit() {
        if (dead) return;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            dead = true;
          }
        }
      },
    };
  },
  '해지하면 모든 리스너가 빠진다': () => {
    const listeners = new Set<Listener>();
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.clear();
        };
      },
      emit() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // 무시
          }
        }
      },
    };
  },
  '해지가 듣지 않는다': () => {
    const listeners = new Set<Listener>();
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {};
      },
      emit() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // 무시
          }
        }
      },
    };
  },
  '두 번째 해지에서 던진다': () => {
    const listeners = new Set<Listener>();
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          if (!listeners.delete(listener)) throw new Error('already removed');
        };
      },
      emit() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // 무시
          }
        }
      },
    };
  },
};

function failedChecks(make: SubscribableProbeFactory): string[] {
  const failed: string[] = [];
  for (const check of SUBSCRIBABLE_CHECKS) {
    try {
      check.run(make);
    } catch {
      failed.push(check.name);
    }
  }
  return failed;
}

describe('Subscribable 적합성 시험 (protocol/testing.ts) 의 자체 확인', () => {
  defineSubscribableContractTests('약속을 지키는 구현', conforming);

  it('확인은 네 가지다', () => {
    assert.equal(SUBSCRIBABLE_CHECKS.length, 4);
    assert.ok(Object.isFrozen(SUBSCRIBABLE_CHECKS));
  });

  for (const [name, make] of Object.entries(broken)) {
    it(`어긴 구현을 잡는다: ${name}`, () => {
      const failed = failedChecks(make);
      assert.ok(failed.length > 0, '어느 확인에도 걸리지 않았다');
    });
  }

  it('어긴 구현마다 걸리는 확인이 정해져 있다', () => {
    const [order, isolation, survive, unsubscribe] = SUBSCRIBABLE_CHECKS.map((check) => check.name) as [string, string, string, string];
    assert.deepEqual(failedChecks(conforming), []);
    // 순서가 뒤집히면 해지 확인의 기대 순서도 어긋난다
    assert.deepEqual(failedChecks(broken['나중에 붙인 리스너부터 부른다'] as SubscribableProbeFactory), [order, isolation, unsubscribe]);
    assert.deepEqual(failedChecks(broken['리스너를 다음 마이크로태스크에 부른다'] as SubscribableProbeFactory), [order, isolation, survive, unsubscribe]);
    assert.deepEqual(failedChecks(broken['리스너의 예외를 그대로 던진다'] as SubscribableProbeFactory), [isolation, survive]);
    assert.deepEqual(failedChecks(broken['예외를 삼키지만 남은 리스너를 부르지 않는다'] as SubscribableProbeFactory), [isolation, survive]);
    assert.deepEqual(failedChecks(broken['리스너가 던지면 그 뒤로 이벤트를 내지 않는다'] as SubscribableProbeFactory), [survive]);
    assert.deepEqual(failedChecks(broken['해지하면 모든 리스너가 빠진다'] as SubscribableProbeFactory), [unsubscribe]);
    assert.deepEqual(failedChecks(broken['해지가 듣지 않는다'] as SubscribableProbeFactory), [unsubscribe]);
    assert.deepEqual(failedChecks(broken['두 번째 해지에서 던진다'] as SubscribableProbeFactory), [unsubscribe]);
  });
});
