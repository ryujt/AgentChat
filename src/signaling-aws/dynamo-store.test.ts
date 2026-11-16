// DynamoDB 저장소가 SDK 에 무엇을 어떤 조건으로 부르는지 본다(대역).
// 조건식과 갱신식이 실제 DynamoDB 에서 포트의 약속(V-U7)을 지키는지는 배포한 테이블에 `npm run test:store` 로 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { PeerRecord } from '../signaling-core/index.js';
import { createDynamoRoomStore } from './dynamo-store.js';
import { createFakeDynamo, sdkError } from './testing.js';

const T0 = 1_800_000_000_123;
const TABLE = 'agent-chat-test-table';
const ROOM_KEY = '0123456789abcdef0123456789abcdef';
const WINDOW = Math.floor(T0 / LIMITS.RATE_WINDOW_MS);

const record: PeerRecord = {
  roomKey: ROOM_KEY,
  peer: 'alice',
  connId: 'Ab12Cd34Ef56GhI=',
  sid: 'abcdefghijkl',
  keyHash: 'k'.repeat(64),
  seq: 3,
  lastSeenAt: T0,
};

const peerItem = (more: Record<string, unknown> = {}): Record<string, unknown> => ({
  pk: `ROOM#${ROOM_KEY}`,
  sk: 'PEER#alice',
  connId: record.connId,
  sid: record.sid,
  keyHash: record.keyHash,
  seq: record.seq,
  lastSeenAt: record.lastSeenAt,
  ttl: 1,
  ...more,
});

function setup() {
  const dynamo = createFakeDynamo();
  const store = createDynamoRoomStore({ ops: dynamo, tableName: TABLE, now: () => T0 });
  return { dynamo, store };
}

describe('DynamoDB 저장소: 참가자 항목', () => {
  it('getPeer 는 ROOM#/PEER# 키를 강한 일관성으로 읽고 항목을 기록으로 바꾼다', async () => {
    const { dynamo, store } = setup();
    dynamo.respond('get', () => ({ Item: peerItem() }));
    assert.deepEqual(await store.getPeer(ROOM_KEY, 'alice'), record);
    const [input] = dynamo.callsOf('get');
    assert.deepEqual(input, { TableName: TABLE, Key: { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' }, ConsistentRead: true });
  });

  it('getPeer 는 항목이 없으면 null, 속성 모양이 틀리면 던진다(틀린 값으로 판정하지 않는다)', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.getPeer(ROOM_KEY, 'alice'), null);
    dynamo.respond('get', () => ({ Item: peerItem({ seq: '3' }) }));
    await assert.rejects(store.getPeer(ROOM_KEY, 'alice'), { name: 'MalformedItemError' });
    dynamo.respond('get', () => ({ Item: peerItem({ connId: undefined }) }));
    await assert.rejects(store.getPeer(ROOM_KEY, 'alice'), { name: 'MalformedItemError' });
  });

  it('(검토 3차 SERVER-R3-01) 읽기는 claimed 속성을 기록의 claimed: true 로 싣는다. 없으면 키가 없고, 참이 아닌 값은 던진다', async () => {
    const { dynamo, store } = setup();
    dynamo.respond('get', () => ({ Item: peerItem({ claimed: true }) }));
    assert.deepEqual(await store.getPeer(ROOM_KEY, 'alice'), { ...record, claimed: true });
    dynamo.respond('query', () => ({ Items: [peerItem({ claimed: true }), peerItem({ sk: 'PEER#bob' })] }));
    assert.deepEqual(await store.listPeers(ROOM_KEY), [{ ...record, claimed: true }, { ...record, peer: 'bob' }]);
    dynamo.respond('get', () => ({ Item: peerItem({ claimed: 'yes' }) }));
    await assert.rejects(store.getPeer(ROOM_KEY, 'alice'), { name: 'MalformedItemError' });
    // putPeer 는 기록에 claimed 가 실려 와도 쓰지 않는다(새 판은 차지되지 않은 판이다).
    assert.equal(await store.putPeer({ ...record, claimed: true }, { absent: true }), true);
    assert.equal(Object.hasOwn(dynamo.callsOf('put')[0]?.['Item'] as object, 'claimed'), false);
  });

  it('putPeer(absent) 는 attribute_not_exists 조건으로 기록 전체와 ttl(lastSeenAt + 1시간, 초)을 쓴다', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.putPeer(record, { absent: true }), true);
    const [input] = dynamo.callsOf('put');
    assert.equal(input?.['TableName'], TABLE);
    assert.deepEqual(input?.['Item'], {
      pk: `ROOM#${ROOM_KEY}`,
      sk: 'PEER#alice',
      connId: record.connId,
      sid: record.sid,
      keyHash: record.keyHash,
      seq: record.seq,
      lastSeenAt: record.lastSeenAt,
      ttl: Math.floor((T0 + 3_600_000) / 1000),
    });
    assert.equal(input?.['ConditionExpression'], 'attribute_not_exists(#pk)');
    assert.deepEqual(input?.['ExpressionAttributeNames'], { '#pk': 'pk' });
  });

  it('putPeer({connId, seq}) 는 "방금 읽은 연결 ID 와 seq 그대로" 조건으로 덮어쓴다', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.putPeer(record, { connId: 'old-conn', seq: 2 }), true);
    const [input] = dynamo.callsOf('put');
    assert.equal(input?.['ConditionExpression'], '#connId = :connId AND #seq = :seq');
    assert.deepEqual(input?.['ExpressionAttributeValues'], { ':connId': 'old-conn', ':seq': 2 });
  });

  it('조건이 맞지 않으면(ConditionalCheckFailedException) false, 그 밖의 오류는 던진다', async () => {
    const { dynamo, store } = setup();
    const failWith = (error: Error) => () => {
      throw error;
    };
    dynamo.respond('put', failWith(sdkError('ConditionalCheckFailedException', 400)));
    dynamo.respond('update', failWith(sdkError('ConditionalCheckFailedException', 400)));
    dynamo.respond('delete', failWith(sdkError('ConditionalCheckFailedException', 400)));
    assert.equal(await store.putPeer(record, { absent: true }), false);
    assert.equal(await store.touchPeer(ROOM_KEY, 'alice', { connId: record.connId, seenSince: 0 }, T0), false);
    assert.equal(await store.deletePeer(ROOM_KEY, 'alice', { connId: record.connId }), false);

    dynamo.respond('put', failWith(sdkError('ProvisionedThroughputExceededException', 400)));
    dynamo.respond('update', failWith(sdkError('InternalServerError', 500)));
    dynamo.respond('delete', failWith(sdkError('AccessDeniedException', 400)));
    await assert.rejects(store.putPeer(record, { absent: true }), { name: 'ProvisionedThroughputExceededException' });
    await assert.rejects(store.touchPeer(ROOM_KEY, 'alice', { connId: record.connId, seenSince: 0 }, T0), { name: 'InternalServerError' });
    await assert.rejects(store.deletePeer(ROOM_KEY, 'alice', { connId: record.connId }), { name: 'AccessDeniedException' });
  });

  it('listPeers 는 방의 PEER# 항목을 강한 일관성으로 끝까지(쪽 넘김 포함) 읽는다', async () => {
    const { dynamo, store } = setup();
    const pages = [
      { Items: [peerItem()], LastEvaluatedKey: { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' } },
      { Items: [peerItem({ sk: 'PEER#bob', connId: 'other', seq: 1 })] },
    ];
    dynamo.respond('query', () => pages.shift());
    const listed = await store.listPeers(ROOM_KEY);
    assert.deepEqual(
      listed.map((item) => [item.peer, item.connId]),
      [
        ['alice', record.connId],
        ['bob', 'other'],
      ],
    );
    const inputs = dynamo.callsOf('query');
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      assert.equal(input['ConsistentRead'], true);
      assert.equal(input['KeyConditionExpression'], '#pk = :pk AND begins_with(#sk, :prefix)');
      assert.deepEqual(input['ExpressionAttributeValues'], { ':pk': `ROOM#${ROOM_KEY}`, ':prefix': 'PEER#' });
    }
    assert.equal(inputs[0]?.['ExclusiveStartKey'], undefined);
    assert.deepEqual(inputs[1]?.['ExclusiveStartKey'], { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' });
  });

  it('touchPeer 는 연결 ID 가 같고 lastSeenAt 이 seenSince 이상일 때만 lastSeenAt·ttl 을 바꾼다', async () => {
    const { dynamo, store } = setup();
    const since = T0 - LIMITS.PARTICIPANT_STALE_MS;
    assert.equal(await store.touchPeer(ROOM_KEY, 'alice', { connId: record.connId, seenSince: since }, T0 + 5), true);
    const [input] = dynamo.callsOf('update');
    assert.deepEqual(input?.['Key'], { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' });
    assert.equal(input?.['UpdateExpression'], 'SET #lastSeenAt = :now, #ttl = :ttl');
    assert.equal(input?.['ConditionExpression'], '#connId = :connId AND #lastSeenAt >= :since');
    assert.deepEqual(input?.['ExpressionAttributeValues'], {
      ':now': T0 + 5,
      ':ttl': Math.floor((T0 + 5 + 3_600_000) / 1000),
      ':connId': record.connId,
      ':since': since,
    });
  });

  it('deletePeer 는 연결 ID 조건부로 지운다', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.deletePeer(ROOM_KEY, 'alice', { connId: record.connId }), true);
    const [input] = dynamo.callsOf('delete');
    assert.deepEqual(input, {
      TableName: TABLE,
      Key: { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' },
      ConditionExpression: '#connId = :connId',
      ExpressionAttributeNames: { '#connId': 'connId' },
      ExpressionAttributeValues: { ':connId': record.connId },
    });
  });

  it('(검토 1차 SERVER-R1-01) claimPeer 는 연결 ID 와 lastSeenAt(판)이 같을 때만 claimed 를 표시한다. deletePeer 의 writtenAt 은 같은 판이고 차지되지 않았을 때만 지운다', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.claimPeer(ROOM_KEY, 'alice', { connId: record.connId, writtenAt: T0 }), true);
    const [claim] = dynamo.callsOf('update');
    assert.deepEqual(claim, {
      TableName: TABLE,
      Key: { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' },
      UpdateExpression: 'SET #claimed = :yes',
      ConditionExpression: '#connId = :connId AND #lastSeenAt = :written',
      ExpressionAttributeNames: { '#claimed': 'claimed', '#connId': 'connId', '#lastSeenAt': 'lastSeenAt' },
      ExpressionAttributeValues: { ':yes': true, ':connId': record.connId, ':written': T0 },
    });
    assert.equal(await store.deletePeer(ROOM_KEY, 'alice', { connId: record.connId, writtenAt: T0 }), true);
    const [removal] = dynamo.callsOf('delete');
    assert.deepEqual(removal, {
      TableName: TABLE,
      Key: { pk: `ROOM#${ROOM_KEY}`, sk: 'PEER#alice' },
      ConditionExpression: '#connId = :connId AND #lastSeenAt = :written AND attribute_not_exists(#claimed)',
      ExpressionAttributeNames: { '#connId': 'connId', '#lastSeenAt': 'lastSeenAt', '#claimed': 'claimed' },
      ExpressionAttributeValues: { ':connId': record.connId, ':written': T0 },
    });
    const failWith = (error: Error) => () => {
      throw error;
    };
    dynamo.respond('update', failWith(sdkError('ConditionalCheckFailedException', 400)));
    assert.equal(await store.claimPeer(ROOM_KEY, 'alice', { connId: record.connId, writtenAt: T0 }), false);
    dynamo.respond('update', failWith(sdkError('InternalServerError', 500)));
    await assert.rejects(store.claimPeer(ROOM_KEY, 'alice', { connId: record.connId, writtenAt: T0 }), { name: 'InternalServerError' });
  });

  it('putPeer 는 항목 전체를 쓰므로 앞 판의 claimed 표시가 남지 않는다', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.putPeer(record, { absent: true }), true);
    const [input] = dynamo.callsOf('put');
    assert.equal('claimed' in (input?.['Item'] ?? {}), false);
    assert.equal(input?.['UpdateExpression'], undefined, 'Put 이다(Update 가 아니다)');
  });
});

describe('DynamoDB 저장소: 연결 항목', () => {
  it('hitRate 는 쓰기 한 번으로 이번 창의 건수를 올리고(없으면 만든다) 등록과 건수를 돌려준다', async () => {
    const { dynamo, store } = setup();
    dynamo.respond('update', () => ({ Attributes: { pk: 'CONN#c1', sk: 'CONN', [`w${WINDOW}`]: 7, roomKey: ROOM_KEY, peer: 'alice', sid: 'abcdefghijkl' } }));
    assert.deepEqual(await store.hitRate('c1', T0), { count: 7, binding: { roomKey: ROOM_KEY, peer: 'alice', sid: 'abcdefghijkl' } });
    const [input] = dynamo.callsOf('update');
    assert.deepEqual(input?.['Key'], { pk: 'CONN#c1', sk: 'CONN' });
    assert.equal(input?.['UpdateExpression'], 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #window :one REMOVE #old');
    assert.deepEqual(input?.['ExpressionAttributeNames'], { '#ttl': 'ttl', '#window': `w${WINDOW}`, '#old': `w${WINDOW - 2}` });
    assert.deepEqual(input?.['ExpressionAttributeValues'], { ':ttl': Math.floor((T0 + 3 * 3_600_000) / 1000), ':one': 1 });
    assert.equal(input?.['ReturnValues'], 'ALL_NEW');
    assert.equal(input?.['ConditionExpression'], undefined, '건수는 조건 없이 올린다');
  });

  it('hitRate 는 등록이 없으면 binding 이 null 이고, 건수 속성이 없으면 던진다', async () => {
    const { dynamo, store } = setup();
    dynamo.respond('update', () => ({ Attributes: { [`w${WINDOW}`]: 1 } }));
    assert.deepEqual(await store.hitRate('c1', T0), { count: 1, binding: null });
    dynamo.respond('update', () => ({ Attributes: {} }));
    await assert.rejects(store.hitRate('c1', T0), { name: 'MalformedItemError' });
  });

  it('bind 는 등록 셋을 쓰고 실패 횟수를 0 으로 돌린다. 건수 속성은 건드리지 않는다', async () => {
    const { dynamo, store } = setup();
    await store.bind('c1', { roomKey: ROOM_KEY, peer: 'alice', sid: 'abcdefghijkl' });
    const [input] = dynamo.callsOf('update');
    assert.equal(input?.['UpdateExpression'], 'SET #roomKey = :roomKey, #peer = :peer, #sid = :sid, #miss = :zero, #ttl = if_not_exists(#ttl, :ttl)');
    assert.deepEqual(input?.['ExpressionAttributeValues'], {
      ':roomKey': ROOM_KEY,
      ':peer': 'alice',
      ':sid': 'abcdefghijkl',
      ':zero': 0,
      ':ttl': Math.floor((T0 + 3 * 3_600_000) / 1000),
    });
  });

  it('unbind 는 연결 항목을 지우고 지우기 전의 등록을 돌려준다', async () => {
    const { dynamo, store } = setup();
    assert.equal(await store.unbind('c1'), null);
    dynamo.respond('delete', () => ({ Attributes: { roomKey: ROOM_KEY, peer: 'alice', sid: 'abcdefghijkl', w1: 3 } }));
    assert.deepEqual(await store.unbind('c1'), { roomKey: ROOM_KEY, peer: 'alice', sid: 'abcdefghijkl' });
    for (const input of dynamo.callsOf('delete')) {
      assert.deepEqual(input, { TableName: TABLE, Key: { pk: 'CONN#c1', sk: 'CONN' }, ReturnValues: 'ALL_OLD' });
    }
  });

  it('bumpJoinMiss 는 miss 를 원자적으로 1 올리고 올린 값을 돌려준다', async () => {
    const { dynamo, store } = setup();
    dynamo.respond('update', () => ({ Attributes: { miss: 4, ttl: 1 } }));
    assert.equal(await store.bumpJoinMiss('c1'), 4);
    const [input] = dynamo.callsOf('update');
    assert.equal(input?.['UpdateExpression'], 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #miss :one');
    assert.equal(input?.['ReturnValues'], 'UPDATED_NEW');
  });

  it('모든 읽기가 강한 일관성이다', async () => {
    const { dynamo, store } = setup();
    dynamo.respond('query', () => ({ Items: [] }));
    await store.getPeer(ROOM_KEY, 'alice');
    await store.listPeers(ROOM_KEY);
    for (const call of dynamo.calls) assert.equal(call.input['ConsistentRead'], true, call.op);
  });
});
