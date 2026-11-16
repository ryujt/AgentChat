// V-U9: shown_as 표(mcp-interface.md 3.4)의 모든 행과, 입력 조합 전부에서 빠지는 경우가 없다는 것.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRESENCE_STATUSES } from '../protocol/index.js';
import type { PresenceStatus } from '../protocol/index.js';
import type { ShownAs } from './contract.js';
import { selfShownAs, shownAs } from './participants.js';
import type { ShownAsInput } from './participants.js';

/** 아무 조건도 맞지 않는 입력. 행마다 필요한 칸만 바꾼다. */
const BASE: ShownAsInput = {
  linkOpen: false,
  status: null,
  listening: null,
  inServerList: false,
  failedRepeatedly: false,
  versionMismatch: false,
  leftByBye: false,
  everLinked: false,
};

const ALL: readonly ShownAs[] = ['ready', 'working', 'not_ready', 'unreachable', 'left', 'connecting', 'disconnected'];

function* everyInput(): Generator<ShownAsInput> {
  const flags = [false, true];
  const statuses: (PresenceStatus | null)[] = [null, ...PRESENCE_STATUSES];
  const listenings: (boolean | null)[] = [null, false, true];
  for (const linkOpen of flags)
    for (const status of statuses)
      for (const listening of listenings)
        for (const inServerList of flags)
          for (const failedRepeatedly of flags)
            for (const versionMismatch of flags)
              for (const leftByBye of flags)
                for (const everLinked of flags)
                  yield { linkOpen, status, listening, inServerList, failedRepeatedly, versionMismatch, leftByBye, everLinked };
}

describe('참가자 표시 shown_as', () => {
  it('1행: 링크가 열려 있고 ready 이고 수신 중이면 ready', () => {
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'ready', listening: true }), 'ready');
  });

  it('2행: 링크가 열려 있고 working 이면 수신 여부와 무관하게 working', () => {
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'working', listening: false }), 'working');
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'working', listening: true }), 'working');
  });

  it('3행: 링크가 열려 있지만 위 둘이 아니면 not_ready', () => {
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'joined', listening: true }), 'not_ready');
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'ready', listening: false }), 'not_ready', 'ready 인데 수신 대기를 하지 않는다');
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'ready', listening: null }), 'not_ready');
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: null, listening: null }), 'not_ready', 'presence 를 아직 못 받았다');
    assert.equal(shownAs({ ...BASE, linkOpen: true, status: 'left', listening: false }), 'not_ready');
  });

  it('4행: 링크가 없고 서버 목록에 있고 연속 실패했거나 버전이 다르면 unreachable', () => {
    assert.equal(shownAs({ ...BASE, inServerList: true, failedRepeatedly: true }), 'unreachable');
    assert.equal(shownAs({ ...BASE, inServerList: true, versionMismatch: true }), 'unreachable');
    assert.equal(shownAs({ ...BASE, inServerList: true, failedRepeatedly: true, leftByBye: true, everLinked: true }), 'unreachable', '5행보다 먼저다');
    assert.notEqual(shownAs({ ...BASE, inServerList: false, failedRepeatedly: true }), 'unreachable', '서버 목록에 없으면 4행이 아니다');
  });

  it('5행: 마지막 링크가 bye 로 닫혔고 새 시도가 없으면 left', () => {
    assert.equal(shownAs({ ...BASE, leftByBye: true, everLinked: true, status: 'working' }), 'left');
    assert.equal(shownAs({ ...BASE, leftByBye: true, everLinked: true, inServerList: true }), 'left', '서버 목록이 낡아 아직 있어도 떠난 것이다');
  });

  it('6행: 링크가 열린 적이 없고 서버 목록에 있으면 connecting', () => {
    assert.equal(shownAs({ ...BASE, inServerList: true }), 'connecting');
    assert.equal(shownAs({ ...BASE, inServerList: true, status: 'ready', listening: true }), 'connecting', '스냅샷으로 받은 ready 를 믿지 않는다');
  });

  it('7행: 링크가 열린 적이 없고 서버 목록에 없고 presence 가 left 면 left', () => {
    assert.equal(shownAs({ ...BASE, status: 'left' }), 'left');
  });

  it('8행: 그 밖은 disconnected', () => {
    assert.equal(shownAs({ ...BASE, everLinked: true, inServerList: true, status: 'ready', listening: true }), 'disconnected', '링크가 bye 없이 닫혔다');
    assert.equal(shownAs({ ...BASE, status: 'working', listening: true }), 'disconnected', '들어오기 전에 사라진 참가자의 presence 만 있다');
    assert.equal(shownAs({ ...BASE, everLinked: true, status: 'left' }), 'disconnected');
    assert.equal(shownAs(BASE), 'disconnected');
  });

  it('입력 조합 전부(1920가지)가 일곱 값 가운데 하나를 낸다', () => {
    let count = 0;
    const seen = new Set<ShownAs>();
    for (const input of everyInput()) {
      const result = shownAs(input);
      assert.ok(ALL.includes(result), `빠진 경우: ${JSON.stringify(input)} → ${String(result)}`);
      seen.add(result);
      count += 1;
    }
    assert.equal(count, 2 * 5 * 3 * 2 ** 5);
    assert.deepEqual([...seen].sort(), [...ALL].sort(), '일곱 값이 모두 나온다');
  });

  it('링크가 열려 있지 않으면 어떤 조합에서도 ready·working·not_ready 가 아니다', () => {
    for (const input of everyInput()) {
      const result = shownAs(input);
      if (input.linkOpen) {
        assert.ok(['ready', 'working', 'not_ready'].includes(result), JSON.stringify(input));
      } else {
        assert.ok(!['ready', 'working', 'not_ready'].includes(result), JSON.stringify(input));
      }
    }
  });

  it('표를 위에서부터 읽은 것과 모든 조합에서 같다', () => {
    // 표를 조건식 그대로 다시 적었다. 구현의 가지 순서가 바뀌면 여기서 어긋난다.
    const byTable = (i: ShownAsInput): ShownAs => {
      const rows: [boolean, ShownAs][] = [
        [i.linkOpen && i.status === 'ready' && i.listening === true, 'ready'],
        [i.linkOpen && i.status === 'working', 'working'],
        [i.linkOpen, 'not_ready'],
        [!i.linkOpen && i.inServerList && (i.failedRepeatedly || i.versionMismatch), 'unreachable'],
        [!i.linkOpen && i.leftByBye, 'left'],
        [!i.linkOpen && !i.everLinked && i.inServerList, 'connecting'],
        [!i.linkOpen && !i.everLinked && !i.inServerList && i.status === 'left', 'left'],
      ];
      return rows.find(([matches]) => matches)?.[1] ?? 'disconnected';
    };
    for (const input of everyInput()) assert.equal(shownAs(input), byTable(input), JSON.stringify(input));
  });

  it('create 결과의 자기 행은 자기 status 로만 정한다', () => {
    assert.equal(selfShownAs('ready'), 'ready');
    assert.equal(selfShownAs('working'), 'working');
    assert.equal(selfShownAs('joined'), 'not_ready');
    assert.equal(selfShownAs('left'), 'not_ready');
    assert.equal(selfShownAs(null), 'not_ready');
  });
});
