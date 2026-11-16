// 공용 서버 검증(V-P2, V-P3, V-P5, V-P7)이 함께 쓰는 AWS 조회 도구. 제품 코드가 아니다. src 는 이 파일을 import 하지 않는다.
// 하는 일은 조회뿐이다: 스택 출력, CloudWatch 지표, CloudWatch Logs, DynamoDB 참가자 항목(강한 일관성 Query).
// 자원을 만들거나 바꾸지 않는다. 자격 증명은 AWS CLI·SDK 의 기본 사슬을 따른다(AWS_PROFILE 로 바꿀 수 있다).
//
// 출력·파일 규칙: 받은 로그 원문은 호출한 쪽이 정한 폴더(세션 스크래치)에만 쓴다(권한 600).
// 표준 출력에는 건수와 시각만 쓴다. 계정 ID, API ID 원문, 방 ID, 참가자 이름을 출력하지 않는다.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

const run = promisify(execFile);

export const REGION = process.env.AGENT_CHAT_AWS_REGION ?? 'ap-northeast-2';
export const STACK = process.env.AGENT_CHAT_AWS_STACK ?? 'agent-chat-signaling';

/** aws CLI 를 JSON 출력으로 부른다. */
export async function awsJson(args) {
  const { stdout } = await run('aws', [...args, '--region', REGION, '--output', 'json'], { maxBuffer: 512 * 1024 * 1024 });
  return stdout.trim() === '' ? null : JSON.parse(stdout);
}

/** 스택 출력(ApiId, StageName, FunctionName, TableName, FunctionLogGroup, AccessLogGroup). */
export async function stackOutputs() {
  const result = await awsJson(['cloudformation', 'describe-stacks', '--stack-name', STACK]);
  const outputs = {};
  for (const entry of result.Stacks[0].Outputs ?? []) outputs[entry.OutputKey] = entry.OutputValue;
  return outputs;
}

/**
 * 1분 단위 Sum 지표. 데이터가 없는 분은 0 으로 채운다.
 * @returns {Promise<{minute: number, sum: number, present: boolean}[]>} minute 은 epoch ms(분 시작)
 */
export async function metricMinutes({ namespace, metric, dimensions, startMs, endMs }) {
  const dims = Object.entries(dimensions).map(([name, value]) => `Name=${name},Value=${value}`);
  const result = await awsJson([
    'cloudwatch',
    'get-metric-statistics',
    '--namespace',
    namespace,
    '--metric-name',
    metric,
    '--dimensions',
    ...dims,
    '--start-time',
    new Date(startMs).toISOString(),
    '--end-time',
    new Date(endMs).toISOString(),
    '--period',
    '60',
    '--statistics',
    'Sum',
  ]);
  const byMinute = new Map((result.Datapoints ?? []).map((point) => [Date.parse(point.Timestamp), point.Sum]));
  const minutes = [];
  for (let minute = startMs; minute < endMs; minute += 60_000) {
    minutes.push({ minute, sum: byMinute.get(minute) ?? 0, present: byMinute.has(minute) });
  }
  return minutes;
}

/** 구간 [startMs, endMs) 의 분별 값 합. */
export function sumWindow(minutes, startMs, endMs) {
  return minutes.filter((entry) => entry.minute >= startMs && entry.minute < endMs).reduce((total, entry) => total + entry.sum, 0);
}

/** 로그 그룹의 사건 전부(쪽 넘김은 CLI 가 한다). {timestamp, message}[] */
export async function fetchLogEvents(group, startMs, endMs) {
  const result = await awsJson(['logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(startMs), '--end-time', String(endMs)]);
  return (result?.events ?? []).map((event) => ({ timestamp: event.timestamp, message: event.message }));
}

/** 받은 로그 원문을 스크래치 파일로 남긴다(권한 600). */
export function saveRaw(file, value) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

/** 로그 그룹의 보존 일수. */
export async function retentionDays(group) {
  const result = await awsJson(['logs', 'describe-log-groups', '--log-group-name-prefix', group]);
  const found = (result.logGroups ?? []).find((entry) => entry.logGroupName === group);
  return found === undefined ? null : (found.retentionInDays ?? 'never');
}

/** 서버의 방 키(dynamo-store 의 pk 뒷부분)와 로그의 room_ref. */
export function roomKeyOf(roomId) {
  return createHash('sha256').update(roomId, 'utf8').digest('hex').slice(0, 32);
}
export const roomRefOf = (roomId) => roomKeyOf(roomId).slice(0, 12);
export const peerRefOf = (name) => createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12);

/** 방의 참가자 항목을 강한 일관성으로 읽는다. [{peer, lastSeenAt}] */
export function createRoomReader(tableName) {
  const client = new DynamoDBClient({ region: REGION });
  return {
    async peers(roomId) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :peer)',
          ExpressionAttributeValues: { ':pk': { S: `ROOM#${roomKeyOf(roomId)}` }, ':peer': { S: 'PEER#' } },
          ConsistentRead: true,
        }),
      );
      return (result.Items ?? []).map((item) => ({ peer: item.sk.S.slice('PEER#'.length), lastSeenAt: Number(item.lastSeenAt?.N ?? 'NaN') }));
    },
    close: () => client.destroy(),
  };
}

/**
 * 함수 로그 한 줄의 앱 JSON. Lambda 가 앞에 `<시각>\t<요청 ID>\t<수준>\t` 를 붙이므로 첫 `{` 부터 읽는다.
 * 플랫폼 줄(START, END, REPORT, INIT_START)이나 JSON 이 아니면 null.
 */
export function appJson(message) {
  const start = message.indexOf('{');
  if (start < 0 || /^(START|END|REPORT|INIT_START) /.test(message)) return null;
  try {
    return JSON.parse(message.slice(start));
  } catch {
    return null;
  }
}

/** KST 시각 문자열(HH:MM:SS.mmm). */
export function kst(ms) {
  return new Date(ms + 9 * 3600_000).toISOString().slice(11, 23);
}
