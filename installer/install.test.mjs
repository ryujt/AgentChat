// V-L10 (나): 셸 진입점 installer/install.sh (Claude Code + Codex 통합).
// 설치기를 공백이 든 임시 폴더에 복사하고, 가짜 호스트 CLI 와 임시 HOME 으로 실행한다. 실제 사용자 홈에 쓰지 않는다.
//
// 실행: 빌드한 뒤 `node --test installer/*.test.mjs` (묶음별 빌드 폴더를 쓰면 AGENT_CHAT_DIST=<폴더>).
// npm ci 와 빌드는 PATH 앞의 가짜 npm 과 미리 만든 빌드 결과로 대신한다(tests/e2e/install/fixture.mjs).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineShellTests } from '../tests/e2e/install/shell-cases.mjs';

defineShellTests('install.sh', ['claude', 'codex']);

const SCRIPTS = { 'install.sh': 'all', 'claude.sh': 'claude', 'codex.sh': 'codex' };
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
/** 머리 주석 뒤의 본문. */
const body = (name) => read(name).slice(read(name).indexOf('\nset -eu\n'));

describe('V-L10 (나) 셸 진입점 세 개', () => {
  test('세 스크립트는 넘기는 --client 값과 이름만 다르다', () => {
    for (const [name, client] of Object.entries(SCRIPTS)) {
      assert.ok(body(name).includes(`\nCLIENT=${client}\n`), name);
      assert.ok(body(name).includes(`\nSCRIPT_NAME=${name}\n`), name);
      assert.equal(
        body(name).replace(`CLIENT=${client}\n`, 'CLIENT=<client>\n').replace(`SCRIPT_NAME=${name}\n`, 'SCRIPT_NAME=<name>\n'),
        body('install.sh').replace('CLIENT=all\n', 'CLIENT=<client>\n').replace('SCRIPT_NAME=install.sh\n', 'SCRIPT_NAME=<name>\n'),
        name,
      );
    }
  });

  test('POSIX sh, set -eu 이고 실행 권한이 있다. 문법 검사를 통과한다', () => {
    for (const name of Object.keys(SCRIPTS)) {
      const text = read(name);
      assert.ok(text.startsWith('#!/bin/sh\n'), name);
      assert.match(text, /\nset -eu\n/, name);
      assert.equal(statSync(new URL(`./${name}`, import.meta.url)).mode & 0o111, 0o111, `${name} 실행 권한`);
      const checked = spawnSync('/bin/sh', ['-n', fileURLToPath(new URL(`./${name}`, import.meta.url))], { encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
    }
  });

  test('셸이 하는 일은 Node 찾기와 install.mjs 실행뿐이다. 호스트 CLI, npm, 설정 파일을 직접 다루지 않는다', () => {
    for (const name of Object.keys(SCRIPTS)) {
      // 주석과, 값만 정하는 두 줄(CLIENT, SCRIPT_NAME)을 뺀 실행 줄만 본다.
      const code = body(name).split('\n').filter((line) => !line.trim().startsWith('#') && !/^(?:CLIENT|SCRIPT_NAME)=/.test(line)).join('\n');
      assert.doesNotMatch(code, /\b(?:npm|claude|codex|git|curl|wget|rm|cp|mv|sudo|chmod)\b/, name);
      assert.doesNotMatch(code, /\.claude|\.codex|config\.toml|settings\.json/, name);
      assert.equal(code.match(/scripts\/install\.mjs/g)?.length, 2, name);
      assert.doesNotMatch(code, /\$\(\(|\[\[|\bfunction\b|\blocal\b|<<<|\bsource\b/, `${name}: bash 전용 문법`);
    }
  });

  test('머리 주석에 사용법과 환경변수가 있다', () => {
    for (const name of Object.keys(SCRIPTS)) {
      const head = read(name).slice(0, read(name).indexOf('\nset -eu\n'));
      assert.match(head, new RegExp(`# 사용법:\\n#   sh installer/${name.replace('.', '\\.')} `), name);
      assert.match(head, /# 환경변수/, name);
      for (const variable of ['AGENT_CHAT_NODE', 'AGENT_CHAT_HOME', 'AGENT_CHAT_SERVER', 'AGENT_CHAT_IN_PLACE']) assert.ok(head.includes(variable), `${name}: ${variable}`);
    }
    assert.ok(read('claude.sh').includes('AGENT_CHAT_CLAUDE_BIN') && !read('claude.sh').includes('AGENT_CHAT_CODEX_BIN'));
    assert.ok(read('codex.sh').includes('AGENT_CHAT_CODEX_BIN') && !read('codex.sh').includes('AGENT_CHAT_CLAUDE_BIN'));
  });
});
