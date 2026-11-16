// 설치 끝의 안내 문구 (architecture.md 3.13 설치 단계 11, mcp-interface.md 7.3·10절).
// 설치는 권한 설정을 바꾸지 않는다. 필요한 승인과 재시작을 문장으로 알려 줄 뿐이다.

import { CHANNEL_START_COMMAND, type ChannelsResult } from './channels.js';
import { HOST_LABEL, SERVER_NAME, type HostKind } from './types.js';

/** 호스트가 개발 채널 플래그로 시작할 때 보여 주는 경고문. 그대로 싣는다. */
export const CHANNEL_WARNING =
  '--dangerously-load-development-channels is for local channel development only. ' +
  'Do not use this option to run channels you have downloaded off the internet.';

/** 항상 허용해도 되는 tool. 이미 들어간 방 안에서만 동작한다. */
export const ALWAYS_ALLOW_OK: readonly string[] = [
  'wait_for_messages',
  'send_message',
  'get_status',
  'set_status',
  'confirm_channel',
  'start_scenario',
  'record_claim',
  'record_verification',
  'stop_test',
  'write_report',
  'leave_room',
];

/** 매번 승인으로 남기기를 권하는 tool. 방 참여와 제한 설정이 사용자 눈앞에서만 일어나게 한다. */
export const ASK_EVERY_TIME: readonly string[] = ['create_room', 'join_room', 'start_test'];

export interface GuideInput {
  /** 이번에 등록을 확인한 호스트. */
  readonly registered: readonly HostKind[];
  /** Claude Code 의 Channels 판정. Claude Code 를 다루지 않았으면 null. */
  readonly claudeChannels: ChannelsResult | null;
  readonly appRoot: string;
}

export interface Guide {
  /** 사용자가 직접 해야 하는 일. 하나가 "사용자 조치 필요" 한 건이다. */
  readonly actions: readonly string[];
  /** 알아 둘 것. */
  readonly notes: readonly string[];
}

export function buildGuide(input: GuideInput): Guide {
  const actions: string[] = [];
  const notes: string[] = [];
  for (const host of input.registered) {
    actions.push(`열려 있는 ${HOST_LABEL[host]} 세션을 다시 시작한다. 그래야 ${SERVER_NAME} tool 이 보이고 새 코드를 쓴다.`);
  }
  if (input.registered.length > 0) {
    actions.push(
      'tool 을 처음 부를 때 호스트가 승인을 묻는다. 사용자가 직접 고른다. ' +
        '설치와 에이전트는 권한·허용 목록·hook 설정을 고치지 않는다.',
    );
    notes.push(`"항상 허용"을 골라도 되는 tool: ${ALWAYS_ALLOW_OK.join(', ')} (이미 들어간 방 안에서만 동작한다).`);
    notes.push(
      `매번 승인으로 남기기를 권하는 tool: ${ASK_EVERY_TIME.join(', ')}. ` +
        'MCP 등록은 이 PC 의 모든 세션에 보인다. 방 참여와 테스트 제한이 사용자 눈앞에서만 일어나게 한다.',
    );
    notes.push('방에 들어가면 다른 참가자와 시그널링 서버가 이 PC 의 IP 주소를 본다. 연결 후보에는 내부망 주소도 들어 있다.');
  }
  if (input.registered.includes('claude') && input.claudeChannels !== null && input.claudeChannels !== 'impossible') {
    notes.push('channel 모드는 선택 사항이다(Claude Code). 기본은 poll 이고, 쓰지 않아도 모든 기능이 동작한다.');
    notes.push(`쓰려면 ${CHANNEL_START_COMMAND} 로 시작하고 경고 대화상자에서 직접 승인한다. 호스트가 보여 주는 경고문은 다음과 같다.`);
    notes.push(`  "${CHANNEL_WARNING}"`);
    notes.push(
      'Agent Chat 은 GitHub 에서 받는 서버다. 쓸지는 저장소 코드를 믿을지와 함께 사용자가 정한다. ' +
        '설치는 플래그를 대신 붙이지 않고 승인을 대신하지 않는다.',
    );
    notes.push(
      '입장한 뒤에도 channel 로 바뀌지 않으면 에이전트에게 "대기를 멈추고 턴을 끝내라"고 말한다. ' +
        '채널이 등록돼 있으면 점검 알림이 새 턴을 시작시킨다. 1분 안에 반응이 없으면 채널이 등록되지 않은 것이다. ' +
        '"계속 대기하라"고 말해 poll 로 돌아간다.',
    );
  }
  if (input.registered.includes('codex')) {
    notes.push('Codex 에는 채널이 없다. 에이전트가 wait_for_messages 를 되풀이하는 동안만 자동으로 받는다.');
  }
  if (input.registered.includes('gemini')) {
    notes.push('Gemini CLI 에는 채널이 없다. 에이전트가 wait_for_messages 를 되풀이하는 동안만 자동으로 받는다.');
    notes.push('Gemini CLI 는 신뢰하지 않은 폴더에서 사용자 MCP 서버를 끈다. Agent Chat 을 쓸 폴더를 신뢰(trust)해야 tool 이 보인다.');
  }
  notes.push(`갱신: git -C "${input.appRoot}" pull --ff-only 뒤 sh "${input.appRoot}/installer/install.sh" 를 다시 실행한다.`);
  notes.push(`제거: sh "${input.appRoot}/installer/install.sh" --uninstall`);
  return { actions, notes };
}
