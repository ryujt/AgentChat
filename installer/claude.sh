#!/bin/sh
# Agent Chat 설치 프로그램 (Claude Code 전용).
#
# Node 를 찾아 scripts/install.mjs 에 --client claude 로 넘긴다. 의존성 설치, 빌드, MCP 등록,
# Channels 보고, 연결 점검, 안내는 그쪽이 한다. 권한 설정은 바꾸지 않는다. Codex 는 건드리지 않는다.
#
# 사용법:
#   sh installer/claude.sh              # 설치 또는 갱신 (--install 과 같다)
#   sh installer/claude.sh --uninstall  # Claude Code 의 MCP 등록 제거 (-u 도 같다)
#
# 환경변수 (모두 선택):
#   AGENT_CHAT_NODE        설치에 쓸 Node 실행 파일 (기본값: PATH 의 node). 22 이상이어야 한다.
#                          셸이 찾은 경로(command -v 의 결과. 링크면 링크 그대로)가 MCP 등록의 명령이 된다.
#                          brew 의 /opt/homebrew/bin/node 처럼 버전마다 바뀌지 않는 링크를 쓰면 Node 를 올려도 등록이 그대로다
#   AGENT_CHAT_HOME        기록·로그·백업을 두는 곳 (기본값: $HOME/.agent-chat). 저장소는 받은 자리에서 그대로 등록한다
#   AGENT_CHAT_CLAUDE_BIN  Claude Code CLI 실행 파일 (기본값: claude)
#   AGENT_CHAT_SERVER      연결 점검이 쓸 시그널링 서버 주소 (기본값: 공용 서버)
#
# 종료 코드: 0 성공, 1 실패(Node 없음·인자 오류 포함), 2 실패는 없지만 등록한 호스트 없음.

set -eu

CLIENT=claude
SCRIPT_NAME=claude.sh
MIN_NODE_MAJOR=22

usage() {
  printf '사용법: %s [--install|--uninstall|-u]\n' "$SCRIPT_NAME" >&2
  exit 1
}

[ "$#" -le 1 ] || usage
if [ "$#" -eq 0 ]; then
  set -- --install
fi
case "$1" in
  --install) REMOVE= ;;
  --uninstall|-u) REMOVE=--remove ;;
  *) usage ;;
esac

# 패키지 뿌리는 이 스크립트의 위치에서 구한다. 실행한 작업 폴더에 기대지 않는다.
INSTALLER_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_ROOT="$(dirname -- "$INSTALLER_DIR")"

fail_node() {
  printf '실패: Node.js %s 이상이 필요하다. %s\n' "$MIN_NODE_MAJOR" "$1" >&2
  printf '찾은 경로: %s\n' "${2:-없음}" >&2
  printf 'Node 를 설치하거나 AGENT_CHAT_NODE 로 실행 파일을 알려 준 뒤 다시 실행한다. 아무 것도 바꾸지 않았다.\n' >&2
  exit 1
}

# 셸이 하는 일은 둘뿐이다. Node 를 찾고, 그 Node 로 설치 본체를 실행한다.
NODE_NAME="${AGENT_CHAT_NODE:-node}"
NODE="$(command -v "$NODE_NAME" 2>/dev/null)" || fail_node "$NODE_NAME 을(를) 찾지 못했다." ""
NODE_VERSION="$("$NODE" -e 'process.stdout.write(process.versions.node)' 2>/dev/null)" || fail_node 'Node 를 실행하지 못했다.' "$NODE"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail_node "버전을 읽지 못했다($NODE_VERSION)." "$NODE" ;;
esac
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || fail_node "찾은 버전은 $NODE_VERSION 이다." "$NODE"

# 찾은 경로를 절대 경로로 바꿔 설치 본체에 넘긴다. 등록 명령은 이 경로다(그 Node 와 같은 파일이고 셸 세션마다 만드는
# 일회용 링크가 아닐 때. src/setup chooseNodePath). process.execPath 는 링크를 푼 경로라, 그대로 등록하면 brew upgrade 로
# 옛 버전 폴더가 지워질 때 등록이 깨진다. 거꾸로 fnm 의 fnm_multishells 처럼 셸이 끝나면 지워지는 링크는 쓰지 않는다.
case "$NODE" in
  /*) ;;
  *) NODE="$(pwd)/$NODE" ;;
esac
AGENT_CHAT_INSTALL_NODE=$NODE
export AGENT_CHAT_INSTALL_NODE

# 종료 코드를 그대로 돌려주려고 exec 로 넘긴다.
if [ -n "$REMOVE" ]; then
  exec "$NODE" "$APP_ROOT/scripts/install.mjs" --client "$CLIENT" "$REMOVE"
fi
exec "$NODE" "$APP_ROOT/scripts/install.mjs" --client "$CLIENT"
