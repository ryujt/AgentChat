// 공용 조립의 RoomStore 구현 (architecture.md 3.4, deployment.md 2.4). DynamoDB 테이블 하나다.
// 판정은 넣지 않는다. 규칙은 signaling-core 에만 있다. 여기서는 포트가 약속한 것만 지킨다:
// 모든 읽기는 강한 일관성이고, 조건부 연산은 조건식 하나로 원자적이다.
//
// 항목은 둘이다.
//   참가자: pk = ROOM#<방 키>, sk = PEER#<이름>. connId, sid, keyHash, seq, lastSeenAt, ttl, claimed?(입장 판정을 통과한 처리가 차지함)
//   연결:   pk = CONN#<연결 ID>, sk = CONN.      roomKey?, peer?, sid?, w<창 번호>, miss, ttl
// 방 키는 core 가 만든 해시다. 방 ID 와 key 의 원문은 이 모듈에 오지 않는다.

import type {
  DeleteCommandInput,
  DeleteCommandOutput,
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { LIMITS } from '../protocol/index.js';
import type { Now } from '../protocol/index.js';
import type { ConnBinding, ConnId, PeerRecord, RoomKey, RoomStore } from '../signaling-core/index.js';

/**
 * 저장소가 쓰는 DynamoDB 연산 다섯. Lambda 역할의 권한 다섯(GetItem, PutItem, UpdateItem, DeleteItem, Query)과 같다.
 * 실물은 문서 클라이언트를 감싼 것(aws-clients.ts)이고 시험은 메모리 가짜(testing.ts)다.
 */
export interface DynamoOps {
  get(input: GetCommandInput): Promise<GetCommandOutput>;
  put(input: PutCommandInput): Promise<PutCommandOutput>;
  update(input: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(input: DeleteCommandInput): Promise<DeleteCommandOutput>;
  query(input: QueryCommandInput): Promise<QueryCommandOutput>;
}

export interface DynamoRoomStoreOptions {
  readonly ops: DynamoOps;
  readonly tableName: string;
  /** 시각을 인자로 받지 않는 연산(bind, bumpJoinMiss)이 연결 항목의 ttl 을 정할 때 쓴다. */
  readonly now: Now;
}

/** 참가자 항목의 ttl: lastSeenAt + 1시간. 판정에는 쓰지 않는다. 남은 항목을 치우는 용도다. */
const PEER_TTL_MS = 3_600_000;
/** 연결 항목의 ttl: 생성 + 3시간. 게이트웨이의 최대 연결 시간(2시간)보다 길게 둔다. */
const CONN_TTL_MS = 3 * 3_600_000;
/** 이 창보다 이만큼 앞선 창의 건수를 지운다. 바로 앞 창은 늦게 처리된 메시지가 아직 셀 수 있어 남긴다. */
const WINDOW_KEEP = 2;

const CONN_SK = 'CONN';
const PEER_SK_PREFIX = 'PEER#';
const CONDITION_FAILED = 'ConditionalCheckFailedException';

const roomPk = (roomKey: RoomKey): string => `ROOM#${roomKey}`;
const peerSk = (peer: string): string => `${PEER_SK_PREFIX}${peer}`;
const connKey = (connId: ConnId): { pk: string; sk: string } => ({ pk: `CONN#${connId}`, sk: CONN_SK });
const ttlSeconds = (atMs: number): number => Math.floor(atMs / 1000);

function isConditionFailed(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === CONDITION_FAILED;
}

type Item = Readonly<Record<string, unknown>>;

/** 저장된 값이 약속한 모양이 아니면 던진다. core 가 SERVER_ERROR 로 바꾼다. 틀린 값으로 판정하지 않게 한다. */
class MalformedItemError extends Error {
  constructor(attribute: string) {
    super(`테이블 항목의 속성이 약속한 모양이 아니다: ${attribute}`);
    this.name = 'MalformedItemError';
  }
}

function text(item: Item, attribute: string): string {
  const value = item[attribute];
  if (typeof value !== 'string') throw new MalformedItemError(attribute);
  return value;
}

function count(item: Item, attribute: string): number {
  const value = item[attribute];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new MalformedItemError(attribute);
  return value;
}

function peerOf(roomKey: RoomKey, item: Item): PeerRecord {
  const sk = text(item, 'sk');
  if (!sk.startsWith(PEER_SK_PREFIX)) throw new MalformedItemError('sk');
  // claimPeer 가 쓰는 표시. 있으면 참이어야 한다. 읽기 결과에 실어 core 가 등록 전에 실패한 join 을 알아보게 한다(검토 3차 SERVER-R3-01).
  const claimed = item['claimed'];
  if (claimed !== undefined && claimed !== true) throw new MalformedItemError('claimed');
  return {
    roomKey,
    peer: sk.slice(PEER_SK_PREFIX.length),
    connId: text(item, 'connId'),
    sid: text(item, 'sid'),
    keyHash: text(item, 'keyHash'),
    seq: count(item, 'seq'),
    lastSeenAt: count(item, 'lastSeenAt'),
    ...(claimed === true ? { claimed: true as const } : {}),
  };
}

/** 연결 항목의 등록. 셋이 모두 있어야 등록이다(bind 가 한 번에 쓴다). */
function bindingOf(item: Item | undefined): ConnBinding | null {
  if (item === undefined || item['roomKey'] === undefined) return null;
  return { roomKey: text(item, 'roomKey'), peer: text(item, 'peer'), sid: text(item, 'sid') };
}

export function createDynamoRoomStore(options: DynamoRoomStoreOptions): RoomStore {
  const { ops, tableName: TableName, now } = options;

  return {
    async hitRate(connId, at) {
      // 쓰기 한 번으로 건수 올리기와 등록 읽기를 겸한다. ADD 는 항목이 없으면 만든다.
      const window = Math.floor(at / LIMITS.RATE_WINDOW_MS);
      const attribute = `w${window}`;
      const out = await ops.update({
        TableName,
        Key: connKey(connId),
        UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #window :one REMOVE #old',
        ExpressionAttributeNames: { '#ttl': 'ttl', '#window': attribute, '#old': `w${window - WINDOW_KEEP}` },
        ExpressionAttributeValues: { ':ttl': ttlSeconds(at + CONN_TTL_MS), ':one': 1 },
        ReturnValues: 'ALL_NEW',
      });
      const item = out.Attributes ?? {};
      return { count: count(item, attribute), binding: bindingOf(item) };
    },

    async bind(connId, binding) {
      await ops.update({
        TableName,
        Key: connKey(connId),
        UpdateExpression: 'SET #roomKey = :roomKey, #peer = :peer, #sid = :sid, #miss = :zero, #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#roomKey': 'roomKey', '#peer': 'peer', '#sid': 'sid', '#miss': 'miss', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':roomKey': binding.roomKey,
          ':peer': binding.peer,
          ':sid': binding.sid,
          ':zero': 0,
          ':ttl': ttlSeconds(now() + CONN_TTL_MS),
        },
      });
    },

    async unbind(connId) {
      const out = await ops.delete({ TableName, Key: connKey(connId), ReturnValues: 'ALL_OLD' });
      return bindingOf(out.Attributes);
    },

    async getPeer(roomKey, peer) {
      const out = await ops.get({ TableName, Key: { pk: roomPk(roomKey), sk: peerSk(peer) }, ConsistentRead: true });
      return out.Item === undefined ? null : peerOf(roomKey, out.Item);
    },

    async putPeer(record, condition) {
      const guard: Pick<PutCommandInput, 'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'> =
        condition.absent === true
          ? { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } }
          : {
              ConditionExpression: '#connId = :connId AND #seq = :seq',
              ExpressionAttributeNames: { '#connId': 'connId', '#seq': 'seq' },
              ExpressionAttributeValues: { ':connId': condition.connId, ':seq': condition.seq },
            };
      try {
        await ops.put({
          TableName,
          Item: {
            pk: roomPk(record.roomKey),
            sk: peerSk(record.peer),
            connId: record.connId,
            sid: record.sid,
            keyHash: record.keyHash,
            seq: record.seq,
            lastSeenAt: record.lastSeenAt,
            ttl: ttlSeconds(record.lastSeenAt + PEER_TTL_MS),
          },
          ...guard,
        });
        return true;
      } catch (error) {
        if (isConditionFailed(error)) return false;
        throw error;
      }
    },

    async listPeers(roomKey) {
      const records: PeerRecord[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const out: QueryCommandOutput = await ops.query({
          TableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: { ':pk': roomPk(roomKey), ':prefix': PEER_SK_PREFIX },
          ConsistentRead: true,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        });
        for (const item of out.Items ?? []) records.push(peerOf(roomKey, item));
        startKey = out.LastEvaluatedKey;
      } while (startKey !== undefined);
      return records;
    },

    async touchPeer(roomKey, peer, condition, at) {
      try {
        // 조건이 속성 값을 보므로 항목이 없으면 맞지 않는다. 없는 기록을 만들지 않는다.
        await ops.update({
          TableName,
          Key: { pk: roomPk(roomKey), sk: peerSk(peer) },
          UpdateExpression: 'SET #lastSeenAt = :now, #ttl = :ttl',
          ConditionExpression: '#connId = :connId AND #lastSeenAt >= :since',
          ExpressionAttributeNames: { '#lastSeenAt': 'lastSeenAt', '#ttl': 'ttl', '#connId': 'connId' },
          ExpressionAttributeValues: {
            ':now': at,
            ':ttl': ttlSeconds(at + PEER_TTL_MS),
            ':connId': condition.connId,
            ':since': condition.seenSince,
          },
        });
        return true;
      } catch (error) {
        if (isConditionFailed(error)) return false;
        throw error;
      }
    },

    async claimPeer(roomKey, peer, condition) {
      try {
        // 조건이 속성 값을 보므로 항목이 없으면 맞지 않는다. 없는 기록을 만들지 않는다. putPeer 는 항목 전체를 쓰므로 표시가 없어진다.
        await ops.update({
          TableName,
          Key: { pk: roomPk(roomKey), sk: peerSk(peer) },
          UpdateExpression: 'SET #claimed = :yes',
          ConditionExpression: '#connId = :connId AND #lastSeenAt = :written',
          ExpressionAttributeNames: { '#claimed': 'claimed', '#connId': 'connId', '#lastSeenAt': 'lastSeenAt' },
          ExpressionAttributeValues: { ':yes': true, ':connId': condition.connId, ':written': condition.writtenAt },
        });
        return true;
      } catch (error) {
        if (isConditionFailed(error)) return false;
        throw error;
      }
    },

    async deletePeer(roomKey, peer, condition) {
      try {
        const written = condition.writtenAt !== undefined;
        await ops.delete({
          TableName,
          Key: { pk: roomPk(roomKey), sk: peerSk(peer) },
          ...(written
            ? {
                ConditionExpression: '#connId = :connId AND #lastSeenAt = :written AND attribute_not_exists(#claimed)',
                ExpressionAttributeNames: { '#connId': 'connId', '#lastSeenAt': 'lastSeenAt', '#claimed': 'claimed' },
                ExpressionAttributeValues: { ':connId': condition.connId, ':written': condition.writtenAt },
              }
            : {
                ConditionExpression: '#connId = :connId',
                ExpressionAttributeNames: { '#connId': 'connId' },
                ExpressionAttributeValues: { ':connId': condition.connId },
              }),
        });
        return true;
      } catch (error) {
        if (isConditionFailed(error)) return false;
        throw error;
      }
    },

    async bumpJoinMiss(connId) {
      const out = await ops.update({
        TableName,
        Key: connKey(connId),
        UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #miss :one',
        ExpressionAttributeNames: { '#ttl': 'ttl', '#miss': 'miss' },
        ExpressionAttributeValues: { ':ttl': ttlSeconds(now() + CONN_TTL_MS), ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      });
      return count(out.Attributes ?? {}, 'miss');
    },
  };
}
