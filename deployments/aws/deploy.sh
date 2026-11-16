#!/bin/sh
# 공용 시그널링 서버의 처음 배포와 갱신 (docs/design/deployment.md 2.9, 2.10). 같은 명령이고 여러 번 실행해도 결과가 같다.
#   1. 사전 점검  2. 번들  3. 스택 배포  4. 함수 코드 올리기  5. 출력  6. 검증(verify.mjs)
# 계정 ID, 호스팅 영역 ID, 인증서 ARN 은 저장소에 적지 않는다. 인자로 받는다.
set -eu

usage() {
  cat <<'EOF'
사용법: sh deployments/aws/deploy.sh --region <리전> --domain <도메인> --certificate-arn <ARN> --hosted-zone-id <ID> [옵션]

  --region <리전>               배포 리전 (필수)
  --domain <도메인>             사용자 지정 도메인. 공용 서버는 agent-chat.tools.camp (필수)
  --certificate-arn <ARN>       같은 리전의 ACM 인증서, 상태 ISSUED (필수)
  --hosted-zone-id <ID>         도메인이 속한 Route 53 호스팅 영역 (필수)
  --stack-name <이름>           스택 이름 (기본 agent-chat-signaling)
  --stage <이름>                스테이지 이름 (기본 prod)
  --throttle-rate <수>          스테이지 기본 라우트의 초당 요청 수 (기본 25)
  --throttle-burst <수>         버스트 (기본 100)
  --reserved-concurrency <수>   Lambda 예약 동시 실행 (기본 설정 안 함). 걸려면 버스트 이상으로
  --access-log on|off           API Gateway 접근 로그 (기본 on)
  --alarm-topic-arn <ARN>       주면 시간당 메시지 수 경보를 이 SNS 주제로 보낸다
  --alarm-messages-per-hour <수> 경보 기준 (기본 50000)
  --profile <이름>              AWS CLI 자격 증명 프로필 (기본: CLI 기본값)
  --skip-install                npm ci 를 건너뛴다(이미 설치한 node_modules 를 쓴다)
  --skip-verify                 배포 뒤 verify.mjs 를 실행하지 않는다
  --verify-args "<인자>"        verify.mjs 에 덧붙일 인자 (예: "--rounds 10 --no-flood")
  --verify-full                 갱신 배포에서도 부하 항목(속도 제한 flood, 동시 입장·생성 10회)을 모두 돈다.
                                주지 않으면 갱신 배포의 검증은 flood 를 건너뛰고 동시 항목을 2회로 줄인다.
                                공용 서버를 쓰는 다른 방이 스테이지 스로틀에 걸리지 않게 하려는 것이다(처음 배포는 늘 전체)
  -h, --help                    이 안내

검증의 와이어 시험은 빌드한 protocol 을 읽는다. AGENT_CHAT_DIST 를 주면 그 폴더를, 아니면 npm run build 로 dist 를 만든다.
EOF
}

fail() {
  printf '배포 중단: %s\n' "$*" >&2
  exit 1
}

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || fail "$1 의 값이 빠졌다"
}

is_integer() {
  case "$1" in
    '' | *[!0-9-]* | ?*-*) return 1 ;;
    *) return 0 ;;
  esac
}

REGION=''
DOMAIN=''
CERT_ARN=''
ZONE_ID=''
STACK='agent-chat-signaling'
STAGE='prod'
THROTTLE_RATE=25
THROTTLE_BURST=100
RESERVED=-1
ACCESS_LOG='on'
ALARM_TOPIC=''
ALARM_PER_HOUR=50000
PROFILE=''
SKIP_INSTALL=0
SKIP_VERIFY=0
VERIFY_ARGS=''
VERIFY_FULL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --region) need_value "$@"; REGION=$2; shift 2 ;;
    --domain) need_value "$@"; DOMAIN=$2; shift 2 ;;
    --certificate-arn) need_value "$@"; CERT_ARN=$2; shift 2 ;;
    --hosted-zone-id) need_value "$@"; ZONE_ID=$2; shift 2 ;;
    --stack-name) need_value "$@"; STACK=$2; shift 2 ;;
    --stage) need_value "$@"; STAGE=$2; shift 2 ;;
    --throttle-rate) need_value "$@"; THROTTLE_RATE=$2; shift 2 ;;
    --throttle-burst) need_value "$@"; THROTTLE_BURST=$2; shift 2 ;;
    --reserved-concurrency) need_value "$@"; RESERVED=$2; shift 2 ;;
    --access-log) need_value "$@"; ACCESS_LOG=$2; shift 2 ;;
    --alarm-topic-arn) need_value "$@"; ALARM_TOPIC=$2; shift 2 ;;
    --alarm-messages-per-hour) need_value "$@"; ALARM_PER_HOUR=$2; shift 2 ;;
    --profile) need_value "$@"; PROFILE=$2; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --verify-args) [ $# -ge 2 ] || fail '--verify-args 의 값이 빠졌다'; VERIFY_ARGS=$2; shift 2 ;;
    --verify-full) VERIFY_FULL=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "모르는 인자: $1" ;;
  esac
done

[ -n "$REGION" ] || fail '--region 이 필요하다'
[ -n "$DOMAIN" ] || fail '--domain 이 필요하다'
[ -n "$CERT_ARN" ] || fail '--certificate-arn 이 필요하다'
[ -n "$ZONE_ID" ] || fail '--hosted-zone-id 가 필요하다'
DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's/\.$//')
case "$ACCESS_LOG" in on | off) ;; *) fail '--access-log 는 on 또는 off 다' ;; esac
for pair in "throttle-rate:$THROTTLE_RATE" "throttle-burst:$THROTTLE_BURST" "reserved-concurrency:$RESERVED" "alarm-messages-per-hour:$ALARM_PER_HOUR"; do
  is_integer "${pair#*:}" || fail "--${pair%%:*} 는 정수여야 한다"
done
if [ "$RESERVED" != -1 ] && [ "$RESERVED" -lt "$THROTTLE_BURST" ]; then
  fail "--reserved-concurrency($RESERVED)가 --throttle-burst($THROTTLE_BURST)보다 작다. 넘는 호출의 메시지가 버려진다"
fi

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
TEMPLATE="$ROOT/deployments/aws/template.yaml"
BUNDLE_DIR="$ROOT/build/lambda"
ZIP="$ROOT/build/lambda.zip"

export AWS_PAGER=''
if [ -n "$PROFILE" ]; then export AWS_PROFILE="$PROFILE"; fi

awsr() {
  aws --region "$REGION" "$@"
}

step() {
  printf '\n== %s\n' "$*"
}

# 스택의 값 하나. 읽지 못하면 빈 글이다.
stack_field() {
  awsr cloudformation describe-stacks --stack-name "$STACK" --query "$1" --output text 2>/dev/null || true
}

# 이 제품의 스택인지 확인한다(검토 1차 SERVER-R1-05). --stack-name 을 잘못 주면 같은 계정·리전의 다른 스택을 이 템플릿으로
# 갱신하거나(템플릿에 없는 자원이 지워진다) 지울 수 있다. 확인: 태그 project=agent-chat(이 스크립트가 붙인다)과 템플릿 설명.
# 인자로 outputs 를 주면 출력 ApiId·TableName·FunctionName 도 있어야 한다(만들기가 끝난 스택).
require_own_stack() {
  own_tag=$(stack_field "Stacks[0].Tags[?Key=='project'].Value | [0]")
  [ "$own_tag" = agent-chat ] ||
    fail "스택 $STACK 은 이 제품의 스택으로 보이지 않는다(태그 project=agent-chat 이 없다). --stack-name 을 확인한다. 아무 것도 바꾸지 않았다"
  own_desc=$(stack_field 'Stacks[0].Description')
  case "$own_desc" in
    # 설명의 한글은 CLI 의 출력 인코딩에 따라 ? 로 나올 수 있어(실측) ASCII 부분만 본다.
    'agent-chat '*'API Gateway WebSocket API + Lambda + DynamoDB'*) ;;
    *) fail "스택 $STACK 의 템플릿 설명이 이 제품의 것이 아니다. --stack-name 을 확인한다. 아무 것도 바꾸지 않았다" ;;
  esac
  if [ "${1:-}" = outputs ]; then
    for key in ApiId TableName FunctionName; do
      own_value=$(stack_field "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]")
      [ -n "$own_value" ] && [ "$own_value" != None ] ||
        fail "스택 $STACK 에 출력 $key 이(가) 없다. 이 제품의 스택이 아니거나 망가진 스택이다. 아무 것도 바꾸지 않았다"
    done
  fi
  echo "스택 $STACK: 이 제품의 스택이다(태그, 템플릿 설명${1:+, 출력})"
}

# ── 1. 사전 점검 ──────────────────────────────────────────────────────────────
step '1. 사전 점검'

awsr sts get-caller-identity --query Arn --output text >/dev/null 2>&1 ||
  fail 'aws sts get-caller-identity 가 실패했다. 자격 증명(--profile)을 확인한다'
echo '자격 증명: 확인'

CERT_STATUS=$(awsr acm describe-certificate --certificate-arn "$CERT_ARN" --query Certificate.Status --output text 2>/dev/null) ||
  fail "인증서를 $REGION 에서 찾지 못했다. 같은 리전의 ACM 인증서여야 한다"
[ "$CERT_STATUS" = ISSUED ] ||
  fail "인증서 상태가 $CERT_STATUS 다. ISSUED 여야 한다. DNS 검증 레코드(CNAME)가 호스팅 영역에 있는지 확인한다"
CERT_NAMES=$(awsr acm describe-certificate --certificate-arn "$CERT_ARN" --query 'Certificate.SubjectAlternativeNames' --output text)
PARENT=${DOMAIN#*.}
covered=0
for name in $CERT_NAMES; do
  if [ "$name" = "$DOMAIN" ] || [ "$name" = "*.$PARENT" ]; then covered=1; fi
done
[ "$covered" = 1 ] || fail "인증서의 이름이 $DOMAIN 을 덮지 않는다"
echo "인증서: ISSUED, $DOMAIN 을 덮는다"

ZONE_NAME=$(aws route53 get-hosted-zone --id "$ZONE_ID" --query HostedZone.Name --output text 2>/dev/null) ||
  fail '호스팅 영역을 찾지 못했다'
ZONE_PRIVATE=$(aws route53 get-hosted-zone --id "$ZONE_ID" --query HostedZone.Config.PrivateZone --output text)
ZONE_NAME=${ZONE_NAME%.}
[ "$ZONE_PRIVATE" = False ] || fail '사설 호스팅 영역이다. 공개 영역이어야 한다'
case "$DOMAIN" in
  "$ZONE_NAME" | *".$ZONE_NAME") ;;
  *) fail "$DOMAIN 은 호스팅 영역 $ZONE_NAME 에 속하지 않는다" ;;
esac
echo "호스팅 영역: $ZONE_NAME (공개)"

STACK_STATUS=NONE
if ! out=$(awsr cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1); then
  case "$out" in
    *'does not exist'*) STACK_STATUS=NONE ;;
    *) fail "스택 상태를 읽지 못했다: $out" ;;
  esac
else
  STACK_STATUS=$out
fi
case "$STACK_STATUS" in
  NONE) echo "스택 $STACK: 없음(새로 만든다)" ;;
  ROLLBACK_COMPLETE)
    require_own_stack
    echo "스택 $STACK: ROLLBACK_COMPLETE. 첫 생성이 실패한 스택이라 같은 명령으로 다시 배포되지 않는다. 지우고 처음부터 만든다"
    awsr cloudformation delete-stack --stack-name "$STACK"
    awsr cloudformation wait stack-delete-complete --stack-name "$STACK"
    STACK_STATUS=NONE
    ;;
  *_IN_PROGRESS | *_FAILED) fail "스택 $STACK 의 상태가 $STACK_STATUS 다. 끝나거나 정리된 뒤 다시 실행한다" ;;
  *_COMPLETE)
    require_own_stack outputs
    echo "스택 $STACK: $STACK_STATUS (갱신한다)"
    ;;
  *) fail "스택 $STACK 의 상태를 알 수 없다: $STACK_STATUS" ;;
esac

# 그 도메인 이름에 이 스택이 만들지 않은 레코드가 있으면 덮어쓰지 않는다. 다른 이름(검증용 CNAME 등)은 보지 않는다.
EXISTING=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Name == '$DOMAIN.'].Type" --output text)
if [ -n "$EXISTING" ] && [ "$EXISTING" != None ]; then
  owned=0
  if [ "$STACK_STATUS" != NONE ] && [ "$EXISTING" = A ]; then
    record=$(awsr cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id DnsRecord \
      --query StackResourceDetail.PhysicalResourceId --output text 2>/dev/null || true)
    [ "$record" = "$DOMAIN" ] && owned=1
  fi
  [ "$owned" = 1 ] || fail "$DOMAIN 에 이 스택이 만들지 않은 레코드($EXISTING)가 이미 있다"
  echo "DNS 레코드: 이 스택의 A 레코드가 있다"
else
  echo "DNS 레코드: $DOMAIN 에 아직 없다"
fi

if [ "$ACCESS_LOG" = on ]; then
  CW_ROLE=$(awsr apigateway get-account --query cloudwatchRoleArn --output text 2>/dev/null || true)
  if [ -z "$CW_ROLE" ] || [ "$CW_ROLE" = None ]; then
    fail '접근 로그를 쓰려면 API Gateway 계정 설정에 CloudWatch Logs 역할이 있어야 한다. 계정에 설정하거나 --access-log off 로 배포한다'
  fi
  echo 'API Gateway 계정의 CloudWatch Logs 역할: 있음'
fi

# ── 2. 번들 ──────────────────────────────────────────────────────────────────
step '2. 번들'
if [ "$SKIP_INSTALL" = 0 ]; then
  npm ci
fi
npm run build:lambda
if [ "$SKIP_VERIFY" = 0 ] && [ -z "${AGENT_CHAT_DIST:-}" ]; then
  npm run build
fi
[ -s "$BUNDLE_DIR/index.mjs" ] || fail "번들이 없다: $BUNDLE_DIR/index.mjs"
rm -f "$ZIP"
(cd "$BUNDLE_DIR" && zip -q -X "$ZIP" index.mjs)
ZIP_SHA=$(openssl dgst -sha256 -binary "$ZIP" | openssl base64 -A)
echo "묶음: build/lambda.zip ($(wc -c <"$ZIP" | tr -d ' ') 바이트)"

# ── 3. 스택 배포 ─────────────────────────────────────────────────────────────
step "3. 스택 배포 ($STACK, $REGION)"
if ! awsr cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --tags project=agent-chat \
  --parameter-overrides \
  "DomainName=$DOMAIN" \
  "CertificateArn=$CERT_ARN" \
  "HostedZoneId=$ZONE_ID" \
  "StageName=$STAGE" \
  "ThrottleRate=$THROTTLE_RATE" \
  "ThrottleBurst=$THROTTLE_BURST" \
  "ReservedConcurrency=$RESERVED" \
  "AccessLog=$ACCESS_LOG" \
  "AlarmTopicArn=$ALARM_TOPIC" \
  "AlarmMessagesPerHour=$ALARM_PER_HOUR"; then
  echo '실패한 자원:' >&2
  awsr cloudformation describe-stack-events --stack-name "$STACK" --max-items 40 \
    --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatus, ResourceStatusReason]" \
    --output text >&2 || true
  fail '스택 배포가 실패했다'
fi

output() {
  awsr cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
FUNCTION=$(output FunctionName)
[ -n "$FUNCTION" ] && [ "$FUNCTION" != None ] || fail '스택 출력에 FunctionName 이 없다'

# ── 4. 함수 코드 올리기 ──────────────────────────────────────────────────────
step '4. 함수 코드 올리기'
awsr lambda update-function-code --function-name "$FUNCTION" --zip-file "fileb://$ZIP" --query LastUpdateStatus --output text >/dev/null
awsr lambda wait function-updated --function-name "$FUNCTION"
DEPLOYED_SHA=$(awsr lambda get-function-configuration --function-name "$FUNCTION" --query CodeSha256 --output text)
[ "$DEPLOYED_SHA" = "$ZIP_SHA" ] || fail "올린 코드의 해시가 다르다(로컬 $ZIP_SHA, 함수 $DEPLOYED_SHA)"
echo "함수 $FUNCTION: 코드 갱신 완료 (sha256 $DEPLOYED_SHA)"

# ── 5. 출력 ──────────────────────────────────────────────────────────────────
step '5. 스택 출력'
for key in Url ApiEndpoint ApiId StageName TableName FunctionName FunctionLogGroup AccessLogGroup; do
  value=$(output "$key")
  [ -n "$value" ] && [ "$value" != None ] && printf '%-18s %s\n' "$key" "$value"
done

# ── 6. 검증 ──────────────────────────────────────────────────────────────────
if [ "$SKIP_VERIFY" = 1 ]; then
  step '6. 검증: 건너뜀(--skip-verify). 배포 성공으로 보지 않는다'
  exit 0
fi
# 갱신 배포(이미 쓰는 사람이 있을 수 있다)의 검증은 부하 항목을 줄인다. flood 는 약 16초 동안 스테이지에 초당 약 40건을 걸어
# 스로틀(초당 25)을 넘긴다. 그동안 같은 서버의 모든 방이 pong·joined 를 잃는다(deployment.md 2.11, 검토 1차 SERVER-R1-04).
# 사용자가 준 --verify-args 가 앞에 오므로 그 --rounds 가 이긴다. 전체를 돌리려면 --verify-full.
LOAD_ARGS=''
if [ "$STACK_STATUS" != NONE ] && [ "$VERIFY_FULL" = 0 ]; then
  LOAD_ARGS='--no-flood --rounds 2'
  step '6. 검증 (verify.mjs, 갱신 배포: flood 건너뜀, 동시 항목 2회. 전체는 --verify-full)'
else
  step '6. 검증 (verify.mjs)'
fi
# shellcheck disable=SC2086 # VERIFY_ARGS 와 LOAD_ARGS 는 인자 여러 개로 나눠 넘긴다.
if ! node "$ROOT/deployments/aws/verify.mjs" --domain "$DOMAIN" $VERIFY_ARGS $LOAD_ARGS; then
  fail '검증이 실패했다(verify.mjs)'
fi
echo
echo "배포 완료: wss://$DOMAIN"
