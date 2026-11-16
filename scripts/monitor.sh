#!/bin/sh
# Agent Chat 관전 도구 (docs/design/architecture.md 3.14). 설치 스크립트가 아니다.
#
# 사람이 콘솔에서 방에 관전자로 들어가 에이전트들의 대화와 공유 상태를 실시간으로 본다.
# 콘솔에 글을 입력하고 Enter 를 누르면 방의 에이전트들에게 채팅으로 보낸다(지시). `@이름 글` 은 그 참가자에게만, /help 는 안내.
# Node 를 찾아 dist/entry/monitor.js 로 exec 한다. 셸은 남지 않는다(Ctrl-C 가 Node 에 바로 간다. stdin 도 Node 가 그대로 받는다).
# 공유 상태에 기록을 쓰지 않는다. 다른 참가자에게는 관전자로 표시되고, 보낸 글은 관전자의 글로 표시된다.
#
# 사용법:
#   sh scripts/monitor.sh <room_id> [서버] [--name <이름>] [--json] [--no-color] [--read-only]
#   sh scripts/monitor.sh --room <room_id> --server <주소>
#   sh scripts/monitor.sh -h
#
# 환경변수 (모두 선택):
#   AGENT_CHAT_NODE         쓸 Node 실행 파일 (기본값: PATH 의 node). 22 이상이어야 한다
#   AGENT_CHAT_SERVER       서버를 생략했을 때의 서버 (기본값: 공용 서버 wss://agent-chat.tools.camp)
#   AGENT_CHAT_ICE_SERVERS  ICE 서버 목록 (MCP 와 같은 검증. 받지 않는 값이면 접속하지 않는다)
#   AGENT_CHAT_HOME         진단 로그를 두는 곳 (기본값: $HOME/.agent-chat)
#   NO_COLOR                비어 있지 않으면 색을 끈다
#
# 종료 코드: 0 끝냄(Ctrl-C), 1 입장 실패, 2 인자·설정 오류(Node 나 빌드 결과가 없을 때 포함).

set -eu

MIN_NODE_MAJOR=22

# 패키지 뿌리는 이 스크립트의 위치에서 구한다. 실행한 작업 폴더에 기대지 않는다. 공백이 든 경로도 된다.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_ROOT="$(dirname -- "$SCRIPT_DIR")"
ENTRY="$APP_ROOT/dist/entry/monitor.js"

fail_node() {
  printf 'agent-chat monitor: Node.js %s 이상이 필요하다. %s\n' "$MIN_NODE_MAJOR" "$1" >&2
  printf '찾은 경로: %s\n' "${2:-없음}" >&2
  printf 'Node 를 설치하거나 AGENT_CHAT_NODE 로 실행 파일을 알려 준 뒤 다시 실행한다.\n' >&2
  exit 2
}

NODE_NAME="${AGENT_CHAT_NODE:-node}"
NODE="$(command -v "$NODE_NAME" 2>/dev/null)" || fail_node "$NODE_NAME 을(를) 찾지 못했다." ""
NODE_VERSION="$("$NODE" -e 'process.stdout.write(process.versions.node)' 2>/dev/null)" || fail_node 'Node 를 실행하지 못했다.' "$NODE"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail_node "버전을 읽지 못했다($NODE_VERSION)." "$NODE" ;;
esac
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || fail_node "찾은 버전은 $NODE_VERSION 이다." "$NODE"

if [ ! -f "$ENTRY" ]; then
  printf 'agent-chat monitor: 빌드 결과가 없다: %s\n' "$ENTRY" >&2
  printf '먼저 sh installer/install.sh 또는 npm ci && npm run build 를 실행한다.\n' >&2
  exit 2
fi

# exec 로 넘긴다. 셸이 남지 않고, 종료 코드와 신호가 Node 에 그대로 간다.
exec "$NODE" "$ENTRY" "$@"
