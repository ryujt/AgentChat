// 배포 후 검증 (docs/design/deployment.md 2.11, verification-plan.md V-P1).
// 1번(도메인과 TLS)은 여기서 하고, 2~15번은 저장소의 와이어 계약 테스트(tests/wire/wire-contract.mjs)를 공용 주소로 실행한다.
// 제품 클라이언트 코드를 쓰지 않는다. 와이어 계약만 아는 작은 클라이언트(ws)로 한다.
//
// 쓰는 법:
//   node deployments/aws/verify.mjs --domain agent-chat.tools.camp
//
// 옵션:
//   --domain <도메인>           확인할 사용자 지정 도메인(필수). 접속 주소는 wss://<도메인> 이다.
//   --url <주소>                와이어 시험의 대상 주소(기본 wss://<도메인>). 기본 엔드포인트와 견줄 때 쓴다.
//   --rounds <수>               동시 입장·동시 생성 반복 횟수(기본 10).
//   --timeout-ms <ms>           요청 하나의 기한(기본 10000).
//   --flood-interval-ms <ms>    속도 제한 확인에서 메시지 사이 간격(기본 50). 0 이면 게이트웨이 스로틀에 걸린다.
//   --no-flood                  속도 제한 확인을 건너뛴다(건너뛴 항목은 통과로 세지 않는다).
//   --dns-wait-ms <ms>          도메인이 조회될 때까지 기다리는 시간(기본 180000).
//   --ready-wait-ms <ms>        도메인 매핑이 퍼져 핸드셰이크가 될 때까지 기다리는 시간(기본 420000).
//   --wire-timeout-ms <ms>      와이어 시험 전체의 기한(기본 900000). 넘기면 끊고 실패로 센다.
//
// 끝에 `VERIFY-RESULT {…}` 한 줄로 결과를 낸다. 하나라도 실패하면 종료 코드 1 이다.
// 와이어 시험은 빌드한 protocol 을 읽는다(기본 dist, AGENT_CHAT_DIST 로 바꾼다).

import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import { checkServerIdentity, connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);

function argValue(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
const hasFlag = (name) => argv.includes(`--${name}`);
const integer = (name, fallback) => {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    process.stderr.write(`--${name} 의 값은 0 이상의 정수여야 한다\n`);
    process.exit(2);
  }
  return Number.parseInt(raw, 10);
};

const domain = (argValue('domain') ?? '').toLowerCase().replace(/\.$/, '');
if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) {
  process.stderr.write('확인할 도메인을 --domain <도메인> 으로 준다. 예: --domain agent-chat.tools.camp\n');
  process.exit(2);
}
const url = argValue('url') ?? `wss://${domain}`;
const timeoutMs = integer('timeout-ms', 10_000);
const rounds = integer('rounds', 10);
const floodIntervalMs = integer('flood-interval-ms', 50);
const dnsWaitMs = integer('dns-wait-ms', 180_000);
const readyWaitMs = integer('ready-wait-ms', 420_000);
const wireTimeoutMs = integer('wire-timeout-ms', 900_000);

const result = { domain, url_is_domain: url === `wss://${domain}`, checks: {}, ok: false };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function report(name, ok, detail) {
  result.checks[name] = { ok, ...detail };
  process.stdout.write(`${ok ? '통과' : '실패'}  1. ${name}${detail?.note ? `  (${detail.note})` : ''}\n`);
  return ok;
}

/** 1-가. 도메인이 조회된다. 레코드를 막 만든 직후일 수 있어 기한 안에서 다시 묻는다. */
async function checkDns() {
  const started = Date.now();
  let lastError = '';
  for (let attempt = 1; Date.now() - started <= dnsWaitMs; attempt += 1) {
    try {
      const addresses = await lookup(domain, { all: true });
      if (addresses.length > 0) {
        const families = [...new Set(addresses.map((entry) => `IPv${entry.family}`))];
        return report('도메인 조회', true, { addresses: addresses.length, families, waited_ms: Date.now() - started, attempts: attempt });
      }
    } catch (error) {
      lastError = error.code ?? error.name;
    }
    await delay(5_000);
  }
  return report('도메인 조회', false, { error: lastError, waited_ms: Date.now() - started, note: `${dnsWaitMs}ms 안에 조회되지 않았다` });
}

/** 1-나. TLS: 인증서가 신뢰되고 이름이 도메인과 맞는다. */
function checkTls() {
  return new Promise((resolve) => {
    const socket = connect({ host: domain, port: 443, servername: domain, ALPNProtocols: ['http/1.1'], timeout: timeoutMs });
    const finish = (ok, detail) => {
      socket.destroy();
      resolve(report('TLS 인증서', ok, detail));
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const mismatch = checkServerIdentity(domain, cert);
      finish(socket.authorized && mismatch === undefined, {
        authorized: socket.authorized,
        name_matches: mismatch === undefined,
        protocol: socket.getProtocol(),
        subject_cn: cert.subject?.CN ?? null,
        san: cert.subjectaltname ?? null,
        issuer_o: cert.issuer?.O ?? null,
        valid_to: cert.valid_to ?? null,
      });
    });
    socket.once('timeout', () => finish(false, { error: 'timeout' }));
    socket.once('error', (error) => finish(false, { error: error.code ?? error.name }));
  });
}

/** 한 번 붙어 ping 을 보내고 응답을 본다. 돌려주는 값은 판정에 쓰는 사실만 담는다. */
function handshakeOnce() {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new WebSocket(`wss://${domain}`, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    let openedMs = null;
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, error: 'no reply', open_ms: openedMs }), timeoutMs);
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners('message');
      socket.on('error', () => undefined);
      socket.terminate();
      resolve(outcome);
    };
    socket.once('open', () => {
      openedMs = Date.now() - started;
      socket.send(JSON.stringify({ action: 'ping', id: 'verify-1' }));
    });
    socket.on('message', (data, isBinary) => {
      let message = null;
      try {
        message = isBinary ? null : JSON.parse(String(data));
      } catch {
        // 아래에서 실패로 센다.
      }
      const ok = message?.type === 'error' && message.code === 'NOT_JOINED' && message.re === 'verify-1';
      finish({ ok, open_ms: openedMs, reply_ms: Date.now() - started, reply: message?.type === 'error' ? message.code : (message?.type ?? 'unparsed') });
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ ok: false, error: `HTTP ${response.statusCode}` });
    });
    socket.once('error', (error) => finish({ ok: false, error: error.code ?? error.message }));
  });
}

/**
 * 1-다. WebSocket 핸드셰이크가 되고, 그 연결로 보낸 ping 의 응답(연결 관리 API 로 나간다)이 돌아온다.
 * 스택을 막 만든 뒤에는 도메인 매핑이 퍼지기 전까지 핸드셰이크가 HTTP 400 으로 거절된다(첫 배포에서 약 3분).
 * 그래서 기한(--ready-wait-ms) 안에서 다시 시도하고, 기다린 시간과 처음 본 실패를 기록한다.
 */
async function checkHandshake() {
  const started = Date.now();
  const seen = [];
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await handshakeOnce();
    if (outcome.ok || Date.now() - started > readyWaitMs) {
      return report('WebSocket 핸드셰이크와 응답', outcome.ok, {
        ...outcome,
        attempts: attempt,
        waited_ms: Date.now() - started,
        ...(seen.length > 0 ? { before_ready: [...new Set(seen)] } : {}),
        ...(outcome.ok ? {} : { note: `${readyWaitMs}ms 안에 되지 않았다` }),
      });
    }
    seen.push(outcome.error ?? outcome.reply ?? 'unknown');
    await delay(10_000);
  }
}

/** 2~15번. 와이어 계약 테스트를 자식 프로세스로 돌리고 출력을 그대로 흘려보낸다. */
function runWireContract() {
  const args = [
    '--test-reporter=spec',
    // 시험이 다 끝난 뒤에도 남은 소켓이 있으면(게이트웨이가 403 응답 뒤에도 연결을 열어 둔다) 프로세스가 끝나지 않는다.
    // 판정은 바꾸지 않고, 모든 시험이 끝나면 프로세스를 끝내게 한다.
    '--test-force-exit',
    path.join(ROOT, 'tests', 'wire', 'wire-contract.mjs'),
    '--url',
    url,
    '--rounds',
    String(rounds),
    '--timeout-ms',
    String(timeoutMs),
    '--flood-interval-ms',
    String(floodIntervalMs),
    ...(hasFlag('no-flood') ? ['--no-flood'] : []),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // 끝나지 않는 실행을 무한정 기다리지 않는다. 기한을 넘기면 끊고 실패로 센다.
    const guard = setTimeout(() => child.kill('SIGTERM'), wireTimeoutMs);
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('close', (code, signal) => {
      clearTimeout(guard);
      const counts = {};
      for (const match of text.matchAll(/^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[match[1]] = Number(match[2]);
      const wireLine = /^WIRE-RESULT (\{.*\})$/m.exec(text);
      let wire = null;
      try {
        wire = wireLine ? JSON.parse(wireLine[1]) : null;
      } catch {
        wire = null;
      }
      const failed = [...text.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map((match) => match[1]).filter((name) => name !== 'failing tests:');
      resolve({ exit: code, signal, duration_ms: Date.now() - started, counts, failed: [...new Set(failed)], measured: wire });
    });
  });
}

async function main() {
  process.stdout.write(`배포 검증: wss://${domain}${url === `wss://${domain}` ? '' : ` (와이어 시험 대상 ${url})`}\n`);
  const dnsOk = await checkDns();
  const tlsOk = dnsOk && (await checkTls());
  const handshakeOk = tlsOk && (await checkHandshake());
  if (!handshakeOk) {
    process.stdout.write('1번이 실패해 와이어 계약 시험(2~15번)을 실행하지 않았다\n');
    result.wire = null;
  } else {
    process.stdout.write('\n2~15. 와이어 계약 시험 (tests/wire/wire-contract.mjs)\n');
    result.wire = await runWireContract();
  }
  const wireOk = result.wire !== null && result.wire.exit === 0 && (result.wire.counts.fail ?? 1) === 0 && (result.wire.counts.pass ?? 0) > 0;
  result.ok = dnsOk && tlsOk && handshakeOk && wireOk;
  process.stdout.write(`\nVERIFY-RESULT ${JSON.stringify(result)}\n`);
  process.stdout.write(result.ok ? '검증 통과\n' : '검증 실패\n');
  process.exitCode = result.ok ? 0 : 1;
}

await main();
