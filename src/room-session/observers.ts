// 관전자 목록 (protocol.md 4.6, architecture.md 3.10 의 "두 모드 공통: 관전자 링크의 처리").
// 관전자인지는 링크마다 그 링크의 hello.observer 로만 안다. 서버 목록에는 표시가 없다.
// 이 파일은 표 하나다. 링크·서버 목록·시계는 부르는 쪽이 넘긴다. 다른 부분을 부르지 않는다.

import type { LinkStatus, ObserverView } from './contract.js';
import { toIso } from './views.js';

export interface ObserverBook {
  /**
   * 링크의 hello 를 받아들였다. observer 가 참이면 관전자로 적는다(같은 sid 면 since 를 그대로 둔다).
   * 거짓이거나 null(필드 없음 = 구버전)이면 목록에서 뺀다. 같은 이름이 참가자로 다시 들어온 것이다.
   */
  greeted(peer: string, sid: string, observer: boolean | null, at: number): void;
  /**
   * 그 관전자가 bye{leave|shutdown} 을 보냈다. 같은 sid 의 것이면 목록(list)에서 뺀다.
   * 이름은 "끝낸 관전자"로 남겨 둔다. 서버 목록이 갱신되기 전에 참가자(shown_as: left)로 보이지 않게 한다.
   * 같은 이름의 hello 가 다시 오면 그 hello 대로 다시 정한다.
   */
  left(peer: string, sid: string): void;
  /** 관전자로 알려진 이름인가(끝낸 관전자 포함). 참가자 표시와 도달 범위에서 뺄 때 쓴다. */
  has(peer: string): boolean;
  /** 관전자로 알려진 이름 전부(끝낸 관전자 포함. 이름 순). 링크와 서버 목록을 보지 않는다. */
  names(): string[];
  /** 끝내지 않았고, 지금 링크가 있거나(open, connecting) 서버 목록에 있는 관전자. 이름 순. */
  list(linkOf: (peer: string) => LinkStatus, members: readonly string[]): ObserverView[];
}

interface Entry {
  readonly sid: string;
  readonly since: number;
  /** bye{leave|shutdown} 으로 끝냈다. */
  gone: boolean;
}

export function createObserverBook(): ObserverBook {
  const entries = new Map<string, Entry>();
  return {
    greeted(peer, sid, observer, at) {
      if (observer !== true) {
        entries.delete(peer);
        return;
      }
      const known = entries.get(peer);
      if (known !== undefined && known.sid === sid && !known.gone) return;
      entries.set(peer, { sid, since: at, gone: false });
    },
    left(peer, sid) {
      const known = entries.get(peer);
      if (known !== undefined && known.sid === sid) known.gone = true;
    },
    has: (peer) => entries.has(peer),
    names: () => [...entries.keys()].sort(),
    list(linkOf, members) {
      const listed = new Set(members);
      const views: ObserverView[] = [];
      for (const [name, entry] of [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        if (entry.gone) continue;
        const link = linkOf(name);
        if (link === 'none' && !listed.has(name)) continue;
        views.push({ name, link, since: toIso(entry.since, entry.since) });
      }
      return views;
    },
  };
}
