// 관전 실행 (architecture.md 3.14 의 "종료와 종료 코드", S16).
// observe 로 들어가 처음 요약을 쓰고, 싱크를 열어 실시간 사건을 쓰고, 신호를 받으면 bye 를 보내고 끝낸다.
// 세션에서 부르는 것은 observe, observed, shutdown, 그리고 사람이 입력한 글을 보내는 sendChat 이다. 공유 상태에 쓰는 호출은 없다.

import { refOf } from '../protocol/index.js';
import type { SessionFailure, SignalingState } from '../room-session/contract.js';
import type { MonitorDeps, MonitorEndReason, MonitorExitCode, MonitorHandle, RunMonitor } from './contract.js';
import { formatNotice, formatSent, formatSnapshot, jsonLine, liveHeader, oneLine } from './format.js';
import { INPUT_HELP, parseChatInput } from './input.js';

/** 종료 예산(bye{shutdown} → 서버 leave → 링크 정리). 정하지 않은 값이다 **[제안]**. */
export const MONITOR_SHUTDOWN_BUDGET_MS = 1500;
/** 시그널링 상태와 "관전자만 남음"을 보는 간격 **[제안]**. */
export const MONITOR_POLL_MS = 2000;

const PREFIX = 'agent-chat monitor:';

/** 입장 실패의 종료 코드. 인자·설정 오류는 2, 취소는 0, 그 밖은 1. */
export function exitCodeOf(failure: SessionFailure): MonitorExitCode {
  if (failure.code === 'INVALID_ARGUMENT' || failure.code === 'ICE_CONFIG_REJECTED') return 2;
  if (failure.code === 'CANCELLED') return 0;
  return 1;
}

/** 입장 실패를 사람에게 설명하는 글. 다른 참가자가 쓴 글과 방 ID 를 싣지 않는다. */
export function failureText(failure: SessionFailure, name: string): string {
  switch (failure.code) {
    case 'SIGNALING_ERROR': {
      const code = failure.details.server_code;
      switch (code) {
        case 'ROOM_NOT_FOUND':
          return '방이 없다(아무도 없다). 방 ID 와 서버를 확인하라. 관전자는 방을 만들지 않는다';
        case 'ROOM_FULL':
          return '방이 찼다(8명). 관전자도 정원을 하나 차지한다';
        case 'NAME_IN_USE':
          return `이름 ${name} 을(를) 이미 쓰는 참가자가 있다. --name 으로 다른 이름을 주라`;
        case 'RATE_LIMITED':
          return '서버가 요청이 너무 잦다고 거절했다. 잠시 뒤 다시 실행하라';
        case 'UNSUPPORTED_VERSION':
          return '서버와 프로토콜 버전이 맞지 않는다. Agent Chat 을 갱신하라';
        default:
          return `시그널링 서버가 거절했다(${code})`;
      }
    }
    case 'DIRECT_CONNECT_FAILED': {
      const peers = failure.details.peers.map((peer) => `${peer.name}(${peer.stage}/${peer.reason})`).join(', ');
      return `참가자와 직접 연결하지 못했다: ${peers}. 관전자도 중계 없이 모든 참가자와 직접 연결해야 한다`;
    }
    case 'PEER_VERSION_MISMATCH':
      return `P2P 버전이 다른 참가자가 있다: ${failure.details.peers.map((peer) => peer.name).join(', ')}. 양쪽을 같은 버전으로 맞춰라`;
    case 'SERVER_UNREACHABLE':
      return '시그널링 서버에 접속하지 못했다. 서버 주소와 망을 확인하라';
    case 'NATIVE_LOAD_FAILED':
      return 'WebRTC 모듈(node-datachannel)을 불러오지 못했다. 설치(npm ci, sh installer/install.sh)를 확인하라';
    case 'ICE_CONFIG_REJECTED':
      return 'AGENT_CHAT_ICE_SERVERS 를 받지 않았다';
    case 'INVALID_ARGUMENT':
      return `인자가 틀렸다${failure.detail === undefined ? '' : `: ${failure.detail}`}`;
    case 'CANCELLED':
      return '들어가기 전에 끝냈다';
    default:
      return `들어가지 못했다(${failure.code})`;
  }
}

const SIGNALING_NOTICE: Readonly<Record<SignalingState, string>> = {
  connected: '시그널링 서버에 다시 붙었다',
  reconnecting: '시그널링 재접속 중이다. 열린 링크로 계속 본다',
  detached: '시그널링 재접속을 멈췄다. 열린 링크로 계속 본다',
};

export const runMonitor: RunMonitor = (deps: MonitorDeps): MonitorHandle => {
  const { session, sink, options, out, err, style, now, timers, log } = deps;
  const roomRef = refOf(options.roomId);
  const startedAt = now();
  const controller = new AbortController();
  let phase: 'entering' | 'watching' | 'stopping' | 'done' = 'entering';
  let stopReason: MonitorEndReason | null = null;
  let poll: ReturnType<typeof timers.setTimeout> | null = null;
  let signaling: SignalingState = 'connected';
  let alone = false;
  let resolveDone: (code: MonitorExitCode) => void = () => undefined;
  const done = new Promise<MonitorExitCode>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (code: MonitorExitCode): void => {
    if (phase === 'done') return;
    phase = 'done';
    if (poll !== null) timers.clearTimeout(poll);
    poll = null;
    resolveDone(code);
  };

  const iso = (): string => new Date(now()).toISOString();

  const notice = (code: 'signaling' | 'alone', text: string, extra: Readonly<Record<string, string>>): void => {
    if (options.json) out(jsonLine({ type: 'notice', at: iso(), code, ...extra }));
    else out(formatNotice(text, now(), style));
  };

  /** 시그널링이 끊겨도 열린 링크로 계속 본다. 상태가 바뀌면 알린다. 참가자가 모두 나가도 끝내지 않는다. */
  const check = (): void => {
    poll = null;
    if (phase !== 'watching') return;
    const observed = session.observed();
    if (observed.ok) {
      if (observed.signaling !== signaling) {
        signaling = observed.signaling;
        notice('signaling', SIGNALING_NOTICE[signaling], { state: signaling });
      }
      const present = observed.participants.some((participant) => participant.link !== 'none');
      if (!present && !alone) {
        alone = true;
        notice('alone', '방에 연결된 참가자가 없다(관전자만 남았다). 계속 지켜본다. 끝내려면 Ctrl-C', {});
      } else if (present) {
        alone = false;
      }
    }
    poll = timers.setTimeout(check, MONITOR_POLL_MS);
  };

  const shutdown = async (reason: MonitorEndReason): Promise<void> => {
    if (poll !== null) timers.clearTimeout(poll);
    poll = null;
    try {
      await session.shutdown(MONITOR_SHUTDOWN_BUDGET_MS);
    } catch {
      // 종료는 reject 하지 않는 약속이다. 그래도 끝까지 간다.
    }
    sink.close();
    if (options.json) out(jsonLine({ type: 'end', at: iso(), reason }));
    else err(`${PREFIX} 끝냈다. 방에 bye 를 보냈다.`);
    log.event('info', 'monitor', 'monitor.end', {
      room_ref: roomRef,
      reason,
      events: sink.written(),
      events_dropped: sink.dropped(),
      duration_ms: now() - startedAt,
    });
    finish(0);
  };

  const enter = async (): Promise<void> => {
    err(`${PREFIX} 방에 들어가는 중… (최대 약 40초)`);
    const result = await session.observe({ room_id: options.roomId, server: options.server, name: options.name, signal: controller.signal });
    if (!result.ok) {
      const cancelled = result.code === 'CANCELLED' || stopReason !== null;
      log.event(cancelled ? 'info' : 'warn', 'monitor', 'monitor.start', {
        room_ref: roomRef,
        outcome: cancelled ? 'cancelled' : 'failed',
        error_code: result.code === 'SIGNALING_ERROR' ? result.details.server_code : result.code,
        duration_ms: now() - startedAt,
      });
      if (cancelled) {
        if (options.json) out(jsonLine({ type: 'end', at: iso(), reason: stopReason ?? 'interrupted' }));
        err(`${PREFIX} 들어가기 전에 끝냈다.`);
        finish(0);
        return;
      }
      if (options.json) {
        const details = 'details' in result ? { details: result.details } : {};
        out(jsonLine({ type: 'error', code: result.code, detail: result.detail ?? '', ...details }));
      }
      const code = result.code === 'SIGNALING_ERROR' ? `${result.code}/${result.details.server_code}` : result.code;
      err(`${PREFIX} 들어가지 못했다(${code}). ${failureText(result, options.name)}`);
      finish(exitCodeOf(result));
      return;
    }
    log.event('info', 'monitor', 'monitor.start', { room_ref: roomRef, outcome: 'ok', duration_ms: now() - startedAt });
    if (stopReason !== null) {
      // 들어온 순간 신호가 와 있었다. 정리하고 끝낸다.
      phase = 'stopping';
      await shutdown(stopReason);
      return;
    }
    phase = 'watching';
    const { ok: _ok, ...observed } = result;
    sink.seed(observed);
    signaling = observed.signaling;
    if (options.json) {
      out(jsonLine({ type: 'snapshot', at: iso(), ...observed }));
    } else {
      for (const line of formatSnapshot(observed, style, now())) out(line);
    }
    err(
      options.input
        ? `${PREFIX} 관전자 ${options.name} 로 들어왔다. 서버 ${options.serverKey}. 글을 입력하고 Enter 를 누르면 에이전트들에게 보낸다(@이름 글: 그 참가자에게만, /help). 끝내려면 Ctrl-C.`
        : `${PREFIX} 관전자 ${options.name} 로 들어왔다. 서버 ${options.serverKey}. 읽기 전용이다. 끝내려면 Ctrl-C.`,
    );
    if (!options.json) out(liveHeader(style));
    sink.start();
    poll = timers.setTimeout(check, MONITOR_POLL_MS);
  };

  void enter().catch(() => {
    log.event('error', 'monitor', 'monitor.start', { room_ref: roomRef, outcome: 'failed', error_code: 'INTERNAL' });
    if (options.json) out(jsonLine({ type: 'error', code: 'INTERNAL_ERROR', detail: 'unexpected error' }));
    err(`${PREFIX} 예상하지 못한 오류로 멈췄다.`);
    finish(1);
  });

  /** 사람이 입력한 한 줄을 보낸다. 결과(전달·미전달·듣지 않음)를 한 줄로 쓴다. */
  const input = async (line: string): Promise<void> => {
    if (!options.input) return;
    const parsed = parseChatInput(line);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'help') {
      for (const text of INPUT_HELP) err(text);
      return;
    }
    if (parsed.kind === 'error') {
      err(`${PREFIX} ${parsed.message}`);
      return;
    }
    if (phase !== 'watching') {
      err(`${PREFIX} 아직 방에 들어가지 않았다(또는 끝내는 중이다). 보내지 않았다.`);
      return;
    }
    const result = await session.sendChat(parsed.to === null ? { text: parsed.text } : { text: parsed.text, to: parsed.to });
    if (!result.ok) {
      const detail = result.detail === undefined ? '' : `: ${oneLine(result.detail)}`;
      if (options.json) out(jsonLine({ type: 'send_error', at: iso(), code: result.code, detail: result.detail ?? '' }));
      err(`${PREFIX} 보내지 못했다(${result.code}${detail}).`);
      return;
    }
    if (options.json) {
      out(
        jsonLine({
          type: 'sent',
          at: iso(),
          message_id: result.message_id,
          to: parsed.to,
          text: parsed.text,
          delivered: result.delivered,
          undelivered: result.undelivered,
          not_listening: result.not_listening ?? [],
        }),
      );
      return;
    }
    const target = parsed.to === null ? '전체' : parsed.to.join(',');
    const parts = [`전달 ${result.delivered.length === 0 ? '없음' : result.delivered.join(',')}`];
    if (result.undelivered.length > 0) {
      parts.push(`미전달 ${result.undelivered.map((entry) => `${entry.name}(${entry.reason})`).join(',')}`);
    }
    if (result.not_listening !== undefined && result.not_listening.length > 0) {
      parts.push(`듣지 않음 ${result.not_listening.map((entry) => entry.name).join(',')}(답이 늦을 수 있다)`);
    }
    out(formatSent(target, parsed.text, parts.join(' · '), now(), style));
  };

  return {
    done,
    input,
    stop(reason) {
      if (phase === 'done') return;
      if (phase === 'stopping') {
        // 정리 중의 두 번째 신호. 기다리지 않는다.
        err(`${PREFIX} 정리를 기다리지 않고 끝낸다.`);
        finish(130);
        return;
      }
      stopReason = reason;
      if (phase === 'entering') {
        // 입장을 취소한다. observe 가 CANCELLED 로 끝나며 정리한다(입장 실패와 같은 정리).
        phase = 'stopping';
        controller.abort();
        return;
      }
      phase = 'stopping';
      void shutdown(reason);
    },
  };
};
