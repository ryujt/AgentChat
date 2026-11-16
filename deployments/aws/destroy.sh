#!/bin/sh
# 공용 시그널링 서버 스택 삭제와 확인 (docs/design/deployment.md 2.10).
# 지워지는 것: DNS 레코드, 도메인 매핑, 도메인, API, 함수, 역할, 로그 그룹, 테이블.
# 남는 것: ACM 인증서, 호스팅 영역(이 스택이 소유하지 않는다).
# 확인은 describe-stacks 와 호스팅 영역의 레코드 목록으로 한다. DNS 조회는 캐시 때문에 흔들려 쓰지 않는다.
set -eu

usage() {
  cat <<'EOF'
사용법: sh deployments/aws/destroy.sh --region <리전> --yes [옵션]

  --region <리전>       스택이 있는 리전 (필수)
  --stack-name <이름>   스택 이름 (기본 agent-chat-signaling)
  --profile <이름>      AWS CLI 자격 증명 프로필
  --yes                 실제로 지운다. 없으면 지울 대상만 출력하고 끝낸다
  -h, --help            이 안내
EOF
}

fail() {
  printf '삭제 중단: %s\n' "$*" >&2
  exit 1
}

REGION=''
STACK='agent-chat-signaling'
PROFILE=''
CONFIRMED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --region) [ $# -ge 2 ] || fail '--region 의 값이 빠졌다'; REGION=$2; shift 2 ;;
    --stack-name) [ $# -ge 2 ] || fail '--stack-name 의 값이 빠졌다'; STACK=$2; shift 2 ;;
    --profile) [ $# -ge 2 ] || fail '--profile 의 값이 빠졌다'; PROFILE=$2; shift 2 ;;
    --yes) CONFIRMED=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "모르는 인자: $1" ;;
  esac
done
[ -n "$REGION" ] || fail '--region 이 필요하다'

export AWS_PAGER=''
if [ -n "$PROFILE" ]; then export AWS_PROFILE="$PROFILE"; fi
awsr() {
  aws --region "$REGION" "$@"
}

if ! STATUS=$(awsr cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1); then
  case "$STATUS" in
    *'does not exist'*) echo "스택 $STACK 이 없다. 지울 것이 없다"; exit 0 ;;
    *) fail "스택 상태를 읽지 못했다: $STATUS" ;;
  esac
fi
case "$STATUS" in
  *_IN_PROGRESS) fail "스택 $STACK 의 상태가 $STATUS 다. 끝난 뒤 다시 실행한다" ;;
esac

# 스택의 값 하나. 읽지 못하면 빈 글이다.
stack_field() {
  awsr cloudformation describe-stacks --stack-name "$STACK" --query "$1" --output text 2>/dev/null || true
}

# 이 제품의 스택인지 확인한다(검토 1차 SERVER-R1-05). --stack-name 을 잘못 주면 관계없는 스택을 지울 수 있다.
# 확인: 태그 project=agent-chat(deploy.sh 가 붙인다)과 템플릿 설명. 만들기가 끝난 스택이면 출력 ApiId·TableName·FunctionName 도 본다.
OWN_TAG=$(stack_field "Stacks[0].Tags[?Key=='project'].Value | [0]")
[ "$OWN_TAG" = agent-chat ] ||
  fail "스택 $STACK 은 이 제품의 스택으로 보이지 않는다(태그 project=agent-chat 이 없다). --stack-name 을 확인한다. 지우지 않았다"
OWN_DESC=$(stack_field 'Stacks[0].Description')
case "$OWN_DESC" in
  # 설명의 한글은 CLI 의 출력 인코딩에 따라 ? 로 나올 수 있어(실측) ASCII 부분만 본다.
  'agent-chat '*'API Gateway WebSocket API + Lambda + DynamoDB'*) ;;
  *) fail "스택 $STACK 의 템플릿 설명이 이 제품의 것이 아니다. --stack-name 을 확인한다. 지우지 않았다" ;;
esac
case "$STATUS" in
  ROLLBACK_COMPLETE | *_FAILED) ;;
  *)
    for key in ApiId TableName FunctionName; do
      value=$(stack_field "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]")
      [ -n "$value" ] && [ "$value" != None ] ||
        fail "스택 $STACK 에 출력 $key 이(가) 없다. 이 제품의 스택이 아닐 수 있다. 지우지 않았다"
    done
    ;;
esac

param() {
  awsr cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text
}
DOMAIN=$(param DomainName)
ZONE_ID=$(param HostedZoneId)

echo "스택 $STACK ($REGION, 상태 $STATUS)"
echo "  도메인: $DOMAIN"
echo "  지워지는 것: DNS A 레코드, 도메인 매핑, 도메인, API, 함수, 역할, 로그 그룹, 테이블"
echo "  남는 것: ACM 인증서, 호스팅 영역"
if [ "$CONFIRMED" = 0 ]; then
  echo '--yes 가 없어 지우지 않았다'
  exit 1
fi

awsr cloudformation delete-stack --stack-name "$STACK"
echo '삭제 요청을 보냈다. 끝나기를 기다린다'
if ! awsr cloudformation wait stack-delete-complete --stack-name "$STACK"; then
  awsr cloudformation describe-stack-events --stack-name "$STACK" --max-items 40 \
    --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatus, ResourceStatusReason]" \
    --output text >&2 || true
  fail '스택 삭제가 끝나지 않았다'
fi

# 확인 1: 스택이 없다.
if out=$(awsr cloudformation describe-stacks --stack-name "$STACK" 2>&1); then
  fail "삭제 뒤에도 스택이 보인다"
fi
case "$out" in
  *'does not exist'*) echo "확인: 스택 $STACK 없음" ;;
  *) fail "삭제 뒤 스택 조회가 다른 이유로 실패했다: $out" ;;
esac

# 확인 2: 호스팅 영역에 그 도메인의 A 레코드가 없다.
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != None ] && [ -n "$ZONE_ID" ] && [ "$ZONE_ID" != None ]; then
  LEFT=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --query "ResourceRecordSets[?Name == '$DOMAIN.' && Type == 'A'] | length(@)" --output text)
  [ "$LEFT" = 0 ] || fail "$DOMAIN 의 A 레코드가 남았다"
  echo "확인: $DOMAIN 의 A 레코드 없음"
fi
echo '삭제 완료'
