// 로컬 기록 파일 (mcp-interface.md 8.2). 한 줄이 JSON 객체 하나다. 덧붙이기만 한다.
// 진단 로그와 다른 곳에 두고 자동으로 지우지 않는다. 채팅 본문은 여기에만 남고 진단 로그에는 남기지 않는다.

import path from 'node:path';
import type { LogPort } from '../diagnostics/log-port.js';
import type { Now } from '../protocol/index.js';
import type {
  OpenTranscriptOptions,
  OpenTranscriptResult,
  RecordWriteResult,
  Transcript,
  TranscriptEntry,
} from './contract.js';
import { ensureRoomDir, errorCode, failure, isoTime, openForAppend, utcStamp } from './paths.js';

/** 기록 파일의 형식 버전. 첫 줄(session)에 적는다. */
export const TRANSCRIPT_FORMAT_VERSION = 1;

/** 파일 이름의 형식. 보고서가 같은 디렉터리의 기록 파일을 찾을 때도 쓴다. */
export const TRANSCRIPT_FILE_PATTERN = /^transcript-\d{8}T\d{6}Z-([a-z0-9]{12})\.jsonl$/;

/** 줄을 받아 쓰는 곳. 실제로는 덧붙이기로 연 파일이다. */
export interface LineSink {
  write(text: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface TranscriptWriterOptions {
  readonly path: string;
  readonly sink: LineSink;
  readonly now: Now;
  readonly log: LogPort;
  readonly roomRef: string;
}

export interface TranscriptWriter extends Transcript {
  /** 첫 줄(session)처럼 TranscriptEntry 가 아닌 줄을 쓴다. */
  writeLine(kind: string, fields: Readonly<Record<string, unknown>>): Promise<RecordWriteResult>;
}

/**
 * 줄을 부른 순서대로 하나씩 쓴다. 쓰기 실패는 결과로 알리고 다음 줄은 다시 시도한다.
 * 기록 실패가 채팅을 멈추면 안 되므로 어떤 경우에도 reject 하지 않는다.
 */
export function createTranscriptWriter(options: TranscriptWriterOptions): TranscriptWriter {
  const { sink, now, log, roomRef } = options;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | null = null;

  const writeLine = (kind: string, fields: Readonly<Record<string, unknown>>): Promise<RecordWriteResult> => {
    if (closing !== null) return Promise.resolve(failure('the transcript is closed'));
    let line: string;
    try {
      // ts 와 kind 를 앞에 둔다. 넘겨받은 값이 두 칸을 덮지 못하게 뒤에서 다시 넣는다(자리는 앞 그대로다).
      const stamp = isoTime(now());
      const entry: Record<string, unknown> = Object.assign({ ts: stamp, kind }, fields);
      entry['ts'] = stamp;
      entry['kind'] = kind;
      line = `${JSON.stringify(entry)}\n`;
    } catch (error) {
      log.event('warn', 'records', 'transcript.write', { room_ref: roomRef, kind, outcome: 'failed', error_code: errorCode(error) });
      return Promise.resolve(failure(`cannot serialize the ${kind} entry: ${errorCode(error)}`));
    }
    const written = tail.then(async (): Promise<RecordWriteResult> => {
      try {
        await sink.write(line);
        return { ok: true };
      } catch (error) {
        log.event('warn', 'records', 'transcript.write', { room_ref: roomRef, kind, outcome: 'failed', error_code: errorCode(error) });
        return failure(`cannot write the transcript: ${errorCode(error)}`);
      }
    });
    tail = written.then(() => undefined);
    return written;
  };

  const append = (entry: TranscriptEntry): Promise<RecordWriteResult> => {
    if (typeof entry !== 'object' || entry === null || typeof entry.kind !== 'string') {
      return Promise.resolve(failure('the entry has no kind'));
    }
    const { kind, ...fields } = entry;
    return writeLine(kind, fields);
  };

  const close = (): Promise<void> => {
    closing ??= tail.then(async () => {
      try {
        await sink.close();
        log.event('info', 'records', 'transcript.close', { room_ref: roomRef, outcome: 'ok' });
      } catch (error) {
        log.event('warn', 'records', 'transcript.close', { room_ref: roomRef, outcome: 'failed', error_code: errorCode(error) });
      }
    });
    return closing;
  };

  return { path: options.path, append, close, writeLine };
}

export async function openTranscript(options: OpenTranscriptOptions): Promise<OpenTranscriptResult> {
  // 진단 로그에는 짧은 사유와 오류 코드만 남긴다. detail 은 호출자에게 가는 글이다.
  const fail = (reason: string, detail: string, roomRef?: string, code?: string): OpenTranscriptResult => {
    try {
      options.log.event('error', 'records', 'transcript.open', { room_ref: roomRef, outcome: 'failed', reason, error_code: code });
    } catch {
      // 로그 실패가 호출자를 멈추면 안 된다.
    }
    return failure(detail);
  };

  try {
    const { meta, now, log } = options;
    const room = await ensureRoomDir(options.dir, meta);
    if (!room.ok) return fail(room.reason, room.detail, undefined, room.errorCode);

    const stamp = utcStamp(now());
    if (stamp === null) return fail('bad_clock', 'the clock returned an invalid time', room.roomRef);
    const file = path.join(room.dir, `transcript-${stamp}-${meta.sid}.jsonl`);

    let sink: LineSink;
    try {
      const handle = await openForAppend(file);
      // appendFile 은 줄을 끝까지 쓴다. write 는 일부만 쓰고 돌아올 수 있다.
      sink = { write: (text) => handle.appendFile(text, 'utf8'), close: () => handle.close() };
    } catch (error) {
      const code = errorCode(error);
      return fail('open_failed', `cannot open the transcript: ${code}`, room.roomRef, code);
    }

    const writer = createTranscriptWriter({ path: file, sink, now, log, roomRef: room.roomRef });
    const first = await writer.writeLine('session', {
      server: meta.server_key,
      room_id: meta.room_id,
      name: meta.name,
      sid: meta.sid,
      package_version: meta.package_version,
      format_version: TRANSCRIPT_FORMAT_VERSION,
    });
    if (!first.ok) {
      await writer.close();
      return fail('write_failed', first.detail, room.roomRef);
    }
    log.event('info', 'records', 'transcript.open', { room_ref: room.roomRef, sid: meta.sid, peer: meta.name, outcome: 'ok' });
    return { ok: true, transcript: { path: writer.path, append: writer.append, close: writer.close } };
  } catch (error) {
    const code = errorCode(error);
    return fail('unexpected', `cannot open the transcript: ${code}`, undefined, code);
  }
}
