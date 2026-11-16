// Subscribable(protocol/runtime-ports.ts)의 구현. 리스너의 예외를 여기서 막아 내는 쪽의 상태를 지킨다.

import type { LogPort } from '../diagnostics/log-port.js';
import type { Subscribable, Unsubscribe } from '../protocol/index.js';

type EventMap<Events> = { [E in keyof Events]: (payload: never) => void };

export interface Emitter<Events extends EventMap<Events>> extends Subscribable<Events> {
  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void;
  /** 모든 리스너를 떼고 이후의 emit 을 버린다. */
  stop(): void;
}

export function createEmitter<Events extends EventMap<Events>>(log: LogPort): Emitter<Events> {
  // 같은 함수를 두 번 붙여도 따로 뗄 수 있게 등록마다 칸을 하나 둔다.
  const slots = new Map<keyof Events, { readonly listener: (...args: never[]) => void }[]>();
  let stopped = false;

  return {
    on<E extends keyof Events>(event: E, listener: Events[E]): Unsubscribe {
      if (stopped) return () => {};
      const slot = { listener: listener as (...args: never[]) => void };
      const list = slots.get(event) ?? [];
      list.push(slot);
      slots.set(event, list);
      return () => {
        const current = slots.get(event);
        if (current === undefined) return;
        const index = current.indexOf(slot);
        if (index >= 0) current.splice(index, 1);
      };
    },

    emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
      if (stopped) return;
      const list = slots.get(event);
      if (list === undefined) return;
      // 리스너가 도는 중에 다른 리스너를 떼도 이번 차례는 그대로 돈다.
      for (const slot of [...list]) {
        try {
          (slot.listener as (...inner: unknown[]) => void)(...args);
        } catch {
          // 오류 내용에는 피어가 준 값이 섞일 수 있어 사건 이름만 남긴다.
          log.event('error', 'mesh', 'listener.failed', { kind: String(event) });
        }
      }
    },

    stop(): void {
      stopped = true;
      slots.clear();
    },
  };
}
