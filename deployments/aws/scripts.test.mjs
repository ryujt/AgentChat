// 배포·삭제 스크립트의 사전 확인(대역). 가짜 aws·npm·node 로 deploy.sh 와 destroy.sh 를 돌린다.
// 실제 AWS 를 부르지 않는다. 스크립트는 임시 폴더에 복사해 돌린다(deploy.sh 는 자기 위치에서 저장소 뿌리를 구하고 build/ 에 쓴다).
//
//   npm run test:deploy        (node --test deployments/aws/scripts.test.mjs)
//
// 본다(검토 1차):
//   SERVER-R1-05  --stack-name 이 이 제품의 스택(태그 project=agent-chat, 템플릿 설명, 출력 ApiId·TableName·FunctionName)이 아니면
//                 갱신·자동 삭제(ROLLBACK_COMPLETE)·삭제를 하지 않는다.
//   SERVER-R1-04  갱신 배포의 검증은 flood 를 건너뛰고 동시 항목을 2회로 줄인다. 처음 배포와 --verify-full 은 전체다.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 시험할 스크립트가 있는 폴더. 변이 시험에서 고친 사본을 가리킬 때만 바꾼다. */
const SOURCE = process.env.DEPLOY_SCRIPTS_DIR ?? HERE;
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const OWN_DESC = 'agent-chat ?? ???? ??. API Gateway WebSocket API + Lambda + DynamoDB. ?? ??? ??.';
const OWN_OUTPUTS = { ApiId: 'abc123def0', TableName: 'agent-chat-signaling-table', FunctionName: 'agent-chat-signaling-fn' };

// 가짜 aws. 받은 인자를 기록하고, 상황(FAKE_STACK)에 맞는 답을 낸다. --query 는 글자 맞추기로만 고른다.
const FAKE_AWS = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'aws', args }) + '\\n');
const plain = args.filter((arg, index) => arg !== '--region' && args[index - 1] !== '--region');
const [service, op] = plain;
const value = (name) => { const index = plain.indexOf(name); return index >= 0 ? plain[index + 1] : ''; };
const query = value('--query');
const stack = JSON.parse(process.env.FAKE_STACK);
const statePath = process.env.FAKE_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (text) => { process.stdout.write(text + '\\n'); process.exit(0); };
const key = service + ' ' + op;
if (key === 'sts get-caller-identity') out('arn:aws:iam::000000000000:user/test');
if (key === 'acm describe-certificate') out(query.includes('Status') ? 'ISSUED' : 'signal.example.org');
if (key === 'route53 get-hosted-zone') out(query.includes('PrivateZone') ? 'False' : 'example.org.');
if (key === 'route53 list-resource-record-sets') out(query.includes('length') ? '0' : '');
if (key === 'apigateway get-account') out('arn:aws:iam::000000000000:role/cw');
if (key === 'cloudformation describe-stacks') {
  // 처음 배포: deploy 를 부른 뒤에는 이 제품의 스택이 있다.
  if (stack.status === null && state.created) Object.assign(stack, { status: 'CREATE_COMPLETE', tag: 'agent-chat', desc: process.env.FAKE_OWN_DESC, outputs: JSON.parse(process.env.FAKE_OWN_OUTPUTS) });
  if (stack.status === null || state.deleted) { process.stderr.write('An error occurred (ValidationError): Stack with id x does not exist\\n'); process.exit(255); }
  if (query.includes('StackStatus')) out(stack.status);
  if (query.includes('Tags')) out(stack.tag ?? 'None');
  if (query.includes('Description')) out(stack.desc ?? 'None');
  const output = /OutputKey=='([A-Za-z]+)'/.exec(query);
  if (output) out((stack.outputs ?? {})[output[1]] ?? (query.includes('[0]') ? 'None' : ''));
  const param = /ParameterKey=='([A-Za-z]+)'/.exec(query);
  if (param) out(param[1] === 'DomainName' ? 'signal.example.org' : 'Z000TEST');
  out('None');
}
if (key === 'cloudformation describe-stack-resource') out('signal.example.org');
if (key === 'cloudformation deploy') { state.created = true; save(); out('deployed'); }
if (key === 'cloudformation delete-stack') { state.deleted = true; save(); out(''); }
if (key === 'cloudformation wait') out('');
if (key === 'cloudformation describe-stack-events') out('');
if (key === 'lambda update-function-code') {
  const zip = value('--zip-file').replace('fileb://', '');
  state.sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(zip)).digest('base64');
  save();
  out('Successful');
}
if (key === 'lambda wait') out('');
if (key === 'lambda get-function-configuration') out(state.sha ?? 'none');
process.stderr.write('fake aws: 모르는 호출 ' + key + '\\n');
process.exit(2);
`;

const FAKE_NPM = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'npm', args }) + '\\n');
if (args[0] === 'run' && args[1] === 'build:lambda') {
  fs.mkdirSync(path.join(process.cwd(), 'build', 'lambda'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'build', 'lambda', 'index.mjs'), 'export const handler = () => {};\\n');
}
`;

// 가짜 node: verify.mjs 를 부른 인자만 기록한다(실제 검증은 하지 않는다).
const FAKE_NODE = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'node', args: process.argv.slice(2) }) + '\\n');
`;

function world(stack) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-chat-deploy-scripts-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'deployments', 'aws'), { recursive: true });
  for (const name of ['deploy.sh', 'destroy.sh', 'template.yaml']) cpSync(path.join(SOURCE, name), path.join(repo, 'deployments', 'aws', name));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const tool = (name, source) => {
    const script = path.join(root, `${name}.cjs`);
    writeFileSync(script, source);
    writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  tool('aws', FAKE_AWS);
  tool('npm', FAKE_NPM);
  tool('node', FAKE_NODE);
  const log = path.join(root, 'calls.jsonl');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    FAKE_LOG: log,
    FAKE_STATE: path.join(root, 'state.json'),
    FAKE_STACK: JSON.stringify(stack),
    FAKE_OWN_DESC: OWN_DESC,
    FAKE_OWN_OUTPUTS: JSON.stringify(OWN_OUTPUTS),
    AGENT_CHAT_DIST: path.join(root, 'dist'),
  };
  const run = (script, args) => {
    const result = spawnSync('/bin/sh', [path.join(repo, 'deployments', 'aws', script), ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const awsOps = () => calls().filter((call) => call.tool === 'aws').map((call) => call.args.filter((arg, i, all) => arg !== '--region' && all[i - 1] !== '--region').slice(0, 2).join(' '));
  return { run, calls, awsOps };
}

const DEPLOY_ARGS = ['--region', 'ap-northeast-2', '--domain', 'signal.example.org', '--certificate-arn', 'arn:aws:acm:ap-northeast-2:000000000000:certificate/x', '--hosted-zone-id', 'Z000TEST', '--skip-install'];
const own = (status, more = {}) => ({ status, tag: 'agent-chat', desc: OWN_DESC, outputs: OWN_OUTPUTS, ...more });

describe('deploy.sh: 이 제품의 스택인지 확인한다 (검토 1차 SERVER-R1-05)', () => {
  for (const [label, stack, reason] of [
    ['태그가 없는 다른 스택', { status: 'UPDATE_COMPLETE', tag: null, desc: 'other app', outputs: {} }, /태그 project=agent-chat 이 없다/],
    ['태그는 같지만 템플릿 설명이 다른 스택', own('UPDATE_COMPLETE', { desc: 'Some other application stack' }), /템플릿 설명이 이 제품의 것이 아니다/],
    ['출력 FunctionName 이 없는 스택', own('CREATE_COMPLETE', { outputs: { ApiId: 'abc123def0', TableName: 't' } }), /출력 FunctionName 이\(가\) 없다/],
  ]) {
    test(`${label}이면 갱신하지 않고 멈춘다`, () => {
      const w = world(stack);
      const result = w.run('deploy.sh', DEPLOY_ARGS);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, reason);
      assert.match(result.output, /아무 것도 바꾸지 않았다/);
      assert.equal(w.awsOps().includes('cloudformation deploy'), false, '스택을 갱신했다');
      assert.deepEqual(w.calls().filter((call) => call.tool === 'npm'), [], '번들까지 갔다');
    });
  }

  test('ROLLBACK_COMPLETE 인 다른 스택은 지우지 않는다', () => {
    const w = world({ status: 'ROLLBACK_COMPLETE', tag: null, desc: 'other', outputs: {} });
    const result = w.run('deploy.sh', DEPLOY_ARGS);
    assert.equal(result.status, 1, result.output);
    assert.equal(w.awsOps().includes('cloudformation delete-stack'), false);
  });

  test('ROLLBACK_COMPLETE 인 이 제품의 스택(출력 없음)은 지우고 처음부터 만든다', () => {
    const w = world(own('ROLLBACK_COMPLETE', { outputs: {} }));
    const result = w.run('deploy.sh', [...DEPLOY_ARGS, '--skip-verify']);
    assert.match(result.output, /이 제품의 스택이다\(태그, 템플릿 설명\)/);
    assert.equal(w.awsOps().includes('cloudformation delete-stack'), true);
  });
});

describe('deploy.sh: 갱신 배포의 검증 부하 (검토 1차 SERVER-R1-04)', () => {
  const verifyArgs = (w) => w.calls().find((call) => call.tool === 'node')?.args ?? null;

  test('갱신 배포는 flood 를 건너뛰고 동시 항목을 2회로 줄인다', () => {
    const w = world(own('UPDATE_COMPLETE'));
    const result = w.run('deploy.sh', DEPLOY_ARGS);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /이 제품의 스택이다\(태그, 템플릿 설명, 출력\)/);
    const args = verifyArgs(w);
    assert.ok(args !== null, '검증을 부르지 않았다');
    assert.deepEqual(args.slice(1), ['--domain', 'signal.example.org', '--no-flood', '--rounds', '2']);
    assert.match(result.output, /갱신 배포: flood 건너뜀/);
  });

  test('--verify-args 의 --rounds 가 앞에 와서 이긴다. --verify-full 이면 전체를 돈다', () => {
    const given = world(own('UPDATE_COMPLETE'));
    assert.equal(given.run('deploy.sh', [...DEPLOY_ARGS, '--verify-args', '--rounds 5']).status, 0);
    assert.deepEqual(verifyArgs(given).slice(1), ['--domain', 'signal.example.org', '--rounds', '5', '--no-flood', '--rounds', '2']);
    const full = world(own('UPDATE_COMPLETE'));
    assert.equal(full.run('deploy.sh', [...DEPLOY_ARGS, '--verify-full']).status, 0);
    assert.deepEqual(verifyArgs(full).slice(1), ['--domain', 'signal.example.org']);
  });

  test('처음 배포(스택 없음)는 전체 검증이다', () => {
    const w = world({ status: null });
    const result = w.run('deploy.sh', DEPLOY_ARGS);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(verifyArgs(w).slice(1), ['--domain', 'signal.example.org']);
  });
});

describe('destroy.sh: 이 제품의 스택인지 확인한다 (검토 1차 SERVER-R1-05)', () => {
  test('다른 스택은 --yes 가 있어도 지우지 않는다', () => {
    for (const stack of [{ status: 'CREATE_COMPLETE', tag: null, desc: 'x', outputs: {} }, own('UPDATE_COMPLETE', { desc: 'another app' }), own('UPDATE_COMPLETE', { outputs: {} })]) {
      const w = world(stack);
      const result = w.run('destroy.sh', ['--region', 'ap-northeast-2', '--stack-name', 'someone-else', '--yes']);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /지우지 않았다/);
      assert.equal(w.awsOps().includes('cloudformation delete-stack'), false, JSON.stringify(stack));
    }
  });

  test('이 제품의 스택은 확인을 지난다(--yes 가 없으면 대상만 출력). ROLLBACK_COMPLETE 는 출력 없이도 지운다', () => {
    const dry = world(own('UPDATE_COMPLETE'));
    const listed = dry.run('destroy.sh', ['--region', 'ap-northeast-2']);
    assert.equal(listed.status, 1, listed.output);
    assert.match(listed.output, /--yes 가 없어 지우지 않았다/);
    const failed = world(own('ROLLBACK_COMPLETE', { outputs: {} }));
    const removed = failed.run('destroy.sh', ['--region', 'ap-northeast-2', '--yes']);
    assert.equal(removed.status, 0, removed.output);
    assert.equal(failed.awsOps().includes('cloudformation delete-stack'), true);
  });
});
