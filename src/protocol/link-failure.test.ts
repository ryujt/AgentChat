import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LINK_FAILURE_REASONS,
  LINK_FAILURE_STAGES,
  isLinkFailure,
  type LinkFailure,
} from './link-failure.js';

describe('연결 실패 분류 (3.3)', () => {
  it('단계는 signaling, ice, session 셋이다', () => {
    assert.deepEqual([...LINK_FAILURE_STAGES], ['signaling', 'ice', 'session']);
  });

  it('단계마다 사유가 표와 같다', () => {
    assert.deepEqual([...LINK_FAILURE_REASONS.signaling], ['no_offer', 'no_answer', 'peer_gone']);
    assert.deepEqual([...LINK_FAILURE_REASONS.ice], ['ice_timeout', 'failed']);
    assert.deepEqual([...LINK_FAILURE_REASONS.session], ['hello_timeout', 'hello_mismatch', 'version', 'sync_timeout']);
  });

  it('단계와 사유의 짝이 맞을 때만 참이다', () => {
    const pairs: LinkFailure[] = [
      { stage: 'signaling', reason: 'no_offer' },
      { stage: 'signaling', reason: 'no_answer' },
      { stage: 'signaling', reason: 'peer_gone' },
      { stage: 'ice', reason: 'ice_timeout' },
      { stage: 'ice', reason: 'failed' },
      { stage: 'session', reason: 'hello_timeout' },
      { stage: 'session', reason: 'hello_mismatch' },
      { stage: 'session', reason: 'version' },
      { stage: 'session', reason: 'sync_timeout' },
    ];
    for (const pair of pairs) assert.equal(isLinkFailure(pair.stage, pair.reason), true);
    assert.equal(isLinkFailure('signaling', 'ice_timeout'), false);
    assert.equal(isLinkFailure('ice', 'no_answer'), false);
    assert.equal(isLinkFailure('session', 'failed'), false);
    assert.equal(isLinkFailure('relay', 'failed'), false);
    assert.equal(isLinkFailure('toString', 'length'), false);
    assert.equal(isLinkFailure(undefined, undefined), false);
  });

  it('표를 바꿀 수 없다', () => {
    assert.ok(Object.isFrozen(LINK_FAILURE_REASONS));
    assert.ok(Object.isFrozen(LINK_FAILURE_REASONS.ice));
  });
});
