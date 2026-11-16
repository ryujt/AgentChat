#!/bin/sh
# Agent Chat 제거 프로그램 (Claude Code·Codex·Gemini CLI).
#
# 하는 일 (순서대로):
#   1. Claude Code 의 선택형 Stop hook 을 켜 두었으면 끈다(agent-chat stop-hook off). 다른 설정과 hook 은 건드리지 않는다.
#   2. 호스트의 MCP 등록을 지운다(scripts/install.mjs --remove 와 같다).
#   3. --purge 를 주었을 때만 AGENT_CHAT_HOME(기록·보고서·로그·백업)을 지운다. 기본은 남긴다.
# 저장소 폴더 자체는 지우지 않는다. 마지막에 지울 경로를 알려 준다. 권한 설정은 바꾸지 않는다.
#
# 사용법:
#   sh installer/uninstall.sh                       # 두 호스트의 등록과 Stop hook 제거. 기록은 남긴다
#   sh installer/uninstall.sh --client claude       # Claude Code 만 (claude|codex|gemini|all)
#   sh installer/uninstall.sh --purge               # 위에 더해 AGENT_CHAT_HOME 도 지운다
#
# 환경변수 (모두 선택):
#   AGENT_CHAT_NODE        제거에 쓸 Node 실행 파일 (기본값: PATH 의 node). 22 이상이어야 한다
#   AGENT_CHAT_HOME        기록·로그·백업을 둔 곳 (기본값: $HOME/.agent-chat)
#   AGENT_CHAT_CLAUDE_BIN  Claude Code CLI 실행 파일 (기본값: claude)
#   AGENT_CHAT_CODEX_BIN   Codex CLI 실행 파일 (기본값: codex)
#   AGENT_CHAT_GEMINI_BIN  Gemini CLI 실행 파일 (기본값: gemini)
#   CLAUDE_CONFIG_DIR      Claude Code 설정 폴더 (기본값: $HOME/.claude). Stop hook 을 여기서 지운다
#
# 종료 코드: 0 성공, 1 실패(Node 없음·인자 오류 포함), 2 실패는 없지만 등록을 지운 호스트 없음.

set -eu

SCRIPT_NAME=uninstall.sh
MIN_NODE_MAJOR=22

usage() {
  printf '사용법: %s [--client claude|codex|gemini|all] [--purge]\n' "$SCRIPT_NAME" >&2
  exit 1
}

CLIENT=all
PURGE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --client)
      [ "$#" -ge 2 ] || usage
      case "$2" in
        claude|codex|gemini|all) CLIENT=$2 ;;
        *) usage ;;
      esac
      shift 2
      ;;
    --purge) PURGE=1; shift ;;
    *) usage ;;
  esac
done

# 패키지 뿌리는 이 스크립트의 위치에서 구한다. 실행한 작업 폴더에 기대지 않는다.
INSTALLER_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_ROOT="$(dirname -- "$INSTALLER_DIR")"
CLI="$APP_ROOT/dist/entry/cli.js"

fail_node() {
  printf '실패: Node.js %s 이상이 필요하다. %s\n' "$MIN_NODE_MAJOR" "$1" >&2
  printf '찾은 경로: %s\n' "${2:-없음}" >&2
  printf 'Node 를 설치하거나 AGENT_CHAT_NODE 로 실행 파일을 알려 준 뒤 다시 실행한다. 아무 것도 바꾸지 않았다.\n' >&2
  exit 1
}

NODE_NAME="${AGENT_CHAT_NODE:-node}"
NODE="$(command -v "$NODE_NAME" 2>/dev/null)" || fail_node "$NODE_NAME 을(를) 찾지 못했다." ""
NODE_VERSION="$("$NODE" -e 'process.stdout.write(process.versions.node)' 2>/dev/null)" || fail_node 'Node 를 실행하지 못했다.' "$NODE"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail_node "버전을 읽지 못했다($NODE_VERSION)." "$NODE" ;;
esac
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || fail_node "찾은 버전은 $NODE_VERSION 이다." "$NODE"

STATUS=0

# 1. Stop hook. Claude Code 만 쓴다. 빌드 결과가 없으면 켤 수도 없었으므로 건너뛴다.
if [ "$CLIENT" = claude ] || [ "$CLIENT" = all ]; then
  if [ -f "$CLI" ]; then
    printf '[1] Claude Code Stop hook 끄기\n'
    "$NODE" "$CLI" stop-hook off || STATUS=1
  else
    printf '[1] Claude Code Stop hook 끄기: 건너뜀 — 빌드 결과(%s)가 없다\n' "$CLI"
  fi
fi

# 2. MCP 등록 제거. 종료 코드 2(지운 호스트 없음)는 실패가 아니다.
printf '[2] MCP 등록 제거 (%s)\n' "$CLIENT"
REMOVED=0
"$NODE" "$APP_ROOT/scripts/install.mjs" --client "$CLIENT" --remove || REMOVED=$?
case "$REMOVED" in
  0|2) ;;
  *) STATUS=1 ;;
esac

# 3. 기록 지우기. --purge 일 때만, 그리고 위험한 경로가 아닐 때만 지운다.
DATA_HOME="${AGENT_CHAT_HOME:-${HOME:-}/.agent-chat}"
if [ -n "$PURGE" ]; then
  case "$DATA_HOME" in
    ''|/|.|..|"${HOME:-/}"|"${HOME:-/}/")
      printf '[3] 기록 지우기: 실패 — 지우기에 안전하지 않은 경로다: "%s". 아무 것도 지우지 않았다\n' "$DATA_HOME" >&2
      STATUS=1
      ;;
    *)
      if [ -d "$DATA_HOME" ]; then
        rm -rf -- "$DATA_HOME"
        printf '[3] 기록 지우기: %s 를 지웠다\n' "$DATA_HOME"
      else
        printf '[3] 기록 지우기: 건너뜀 — %s 가 없다\n' "$DATA_HOME"
      fi
      ;;
  esac
else
  printf '[3] 기록은 남겼다: %s (지우려면 --purge)\n' "$DATA_HOME"
fi

printf '저장소 폴더는 지우지 않았다. 더 쓰지 않으면 직접 지운다: %s\n' "$APP_ROOT"
if [ "$STATUS" -ne 0 ]; then
  exit 1
fi
[ "$REMOVED" -eq 2 ] && exit 2
exit 0
