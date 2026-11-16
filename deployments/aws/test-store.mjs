// RoomStore 계약 묶음(V-U7)을 배포한 DynamoDB 테이블에 실행한다 (docs/design/deployment.md 2.6, verification-plan.md V-P1).
// 운영 테이블에 실행하는 사람의 자격으로 직접 쓴다. 시험 항목이 운영 항목과 섞이지 않게 한다:
//   - 방 키와 연결 ID 는 모두 `test-<실행 ID>-` 로 시작한다. 실제 방 키는 16진수 해시, 실제 연결 ID 는 게이트웨이가 만든 값이라 겹치지 않는다.
//   - 그 앞머리가 아닌 키에는 쓰기 전에 멈춘다(운영 항목을 건드리지 않는다).
//   - 끝나면 시험이 쓴 키를 모두 다시 읽어 남은 것을 지우고, 남은 항목이 0 인지 확인한다. 중간에 죽어 남은 항목은 TTL(1~3시간)이 치운다.
//
// 쓰는 법:
//   npm run test:store -- --table <테이블 이름> --region <리전>
//   (자격 증명은 AWS CLI 와 같다. 프로필은 AWS_PROFILE 로 준다.)
//
// 끝에 `STORE-RESULT {…}` 한 줄로 실행 ID, 쓴 항목 수, 남은 항목 수를 낸다. 이 값을 이력에 남긴다.
// 빌드 결과는 dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 준다.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { after } from 'node:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { distPath, distUrl } from '../../tests/support/proc.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const table = argValue('table');
const region = argValue('region') ?? process.env.AWS_REGION;
if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !region || !/^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/.test(region)) {
  process.stderr.write('사용법: npm run test:store -- --table <테이블 이름> --region <리전>\n');
  process.exit(2);
}
if (!existsSync(distPath('signaling-aws', 'index.js'))) {
  process.stderr.write(`빌드 결과가 없다: ${distPath('signaling-aws', 'index.js')}. npm run build 를 먼저 한다(또는 AGENT_CHAT_DIST)\n`);
  process.exit(2);
}

const { defineRoomStoreContractTests } = await import(distUrl('signaling-core', 'testing.js'));
const { createDynamoOps, createDynamoRoomStore } = await import(distUrl('signaling-aws', 'index.js'));

const runId = randomBytes(6).toString('hex');
const prefix = `test-${runId}-`;
const OWN_KEY = [`ROOM#${prefix}`, `CONN#${prefix}`];

const real = createDynamoOps(region);
/** 시험이 쓴 항목의 키(pk\nsk). 성공한 쓰기만 센다. */
const written = new Map();
/** 시험이 쓰려 한 모든 키. 끝난 뒤 남았는지 이것으로 다시 읽는다. */
const touched = new Map();
const calls = { get: 0, put: 0, update: 0, delete: 0, query: 0 };

function guard(op, key) {
  const pk = String(key?.pk ?? '');
  if (!OWN_KEY.some((own) => pk.startsWith(own))) {
    // 운영 항목을 건드리기 전에 멈춘다. 이 묶음이 만든 키가 아니면 결함이다.
    throw new Error(`시험 앞머리가 아닌 키에 ${op} 하려 했다. 멈춘다`);
  }
  return `${pk}\n${key.sk}`;
}

async function writing(op, key, run) {
  const id = guard(op, key);
  touched.set(id, { pk: key.pk, sk: key.sk });
  calls[op] += 1;
  const out = await run();
  if (op !== 'delete') written.set(id, { pk: key.pk, sk: key.sk });
  return out;
}

const ops = {
  get(input) {
    guard('get', input.Key);
    calls.get += 1;
    return real.get(input);
  },
  query(input) {
    guard('query', { pk: input.ExpressionAttributeValues?.[':pk'], sk: '' });
    calls.query += 1;
    return real.query(input);
  },
  put: (input) => writing('put', input.Item, () => real.put(input)),
  update: (input) => writing('update', input.Key, () => real.update(input)),
  delete: (input) => writing('delete', input.Key, () => real.delete(input)),
};

const startedAt = Date.now();
defineRoomStoreContractTests(() => createDynamoRoomStore({ ops, tableName: table, now: () => Date.now() }), {
  name: `DynamoDB ${table} (${region}, 실행 ${runId})`,
  idPrefix: prefix,
});

after(async () => {
  // 남은 항목을 키마다 강한 일관성으로 다시 읽는다. 남았으면 지우고 센다.
  let leftoverBeforeCleanup = 0;
  for (const key of touched.values()) {
    const out = await real.get({ TableName: table, Key: key, ConsistentRead: true });
    if (out.Item !== undefined) {
      leftoverBeforeCleanup += 1;
      await real.delete({ TableName: table, Key: key });
    }
  }
  let leftoverAfter = 0;
  for (const key of touched.values()) {
    const out = await real.get({ TableName: table, Key: key, ConsistentRead: true });
    if (out.Item !== undefined) leftoverAfter += 1;
  }
  // 기록과 따로, 테이블 전체에서 이 실행의 앞머리로 시작하는 항목을 찾는다(Scan 권한이 없으면 null).
  let scanLeftover = null;
  try {
    const scanner = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    scanLeftover = 0;
    let startKey;
    do {
      const out = await scanner.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          ProjectionExpression: 'pk',
          FilterExpression: 'begins_with(pk, :room) OR begins_with(pk, :conn)',
          ExpressionAttributeValues: { ':room': OWN_KEY[0], ':conn': OWN_KEY[1] },
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      scanLeftover += out.Items?.length ?? 0;
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
  } catch (error) {
    scanLeftover = null;
    process.stdout.write(`Scan 확인을 하지 못했다: ${error.name}\n`);
  }
  const summary = {
    run_id: runId,
    table,
    region,
    prefix,
    duration_ms: Date.now() - startedAt,
    calls,
    written_items: written.size,
    touched_keys: touched.size,
    leftover_before_cleanup: leftoverBeforeCleanup,
    leftover_after: leftoverAfter,
    scan_leftover: scanLeftover,
  };
  process.stdout.write(`STORE-RESULT ${JSON.stringify(summary)}\n`);
  assert.equal(leftoverBeforeCleanup, 0, '계약 묶음이 지우지 않고 남긴 항목이 있다');
  assert.equal(leftoverAfter, 0, '정리한 뒤에도 시험 항목이 남았다');
  if (scanLeftover !== null) assert.equal(scanLeftover, 0, '테이블에 이 실행의 앞머리로 시작하는 항목이 남았다');
});
