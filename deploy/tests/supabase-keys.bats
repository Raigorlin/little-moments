#!/usr/bin/env bats
# deploy/bin/lm-supabase-keys 的行為測試（plan.md D6、D16）：輸出恰為 app.env 的 8 個鍵、格式為 lm-deploy 接受的格式、
# anon／service_role JWT 以 JWT secret 驗證、ES256 私鑰與公鑰一致、每次輸出不同。
#
# 執行：bats deploy/tests/supabase-keys.bats（需要 bash ≥ 4.4、openssl、GNU coreutils；不需要 Docker）。

bats_require_minimum_version 1.5.0

load helpers/test_helper

KEYS=(LM_DB_PASSWORD LM_JWT_SECRET LM_ANON_KEY LM_SERVICE_KEY LM_JWT_KEYS LM_JWKS LM_REALTIME_SECRET_KEY_BASE LM_REALTIME_DB_ENC_KEY)

setup() {
  OUT="$BATS_TEST_TMPDIR/keys.env"
  run --separate-stderr bash "$KEYS_TOOL" env staging
  [ "$status" -eq 0 ]
  [ -z "$stderr" ]
  printf '%s\n' "$output" >"$OUT"
}

val() { sed -n "s/^$1=//p" "$OUT"; }

# b64url_dec：base64url（無填補）→ 位元組。
b64url_dec() {
  local s=$1
  s=${s//-/+}
  s=${s//_//}
  while ((${#s} % 4)); do s+='='; done
  printf '%s' "$s" | base64 -d
}

# json_field <json> <key>：取出 "key":"value" 的 value（第一個）。
json_field() { [[ $1 =~ \"$2\":\"([^\"]*)\" ]] && printf '%s' "${BASH_REMATCH[1]}"; }

@test "keys: exactly the eight app.env keys, one line each, in order" {
  [ "$(wc -l <"$OUT")" -eq 8 ]
  mapfile -t got < <(cut -d= -f1 "$OUT")
  [ "${got[*]}" = "${KEYS[*]}" ]
  local k
  for k in "${KEYS[@]}"; do [ -n "$(val "$k")" ]; done
}

@test "keys: formats match lm-deploy's validators (lm-deploy app-env accepts the output)" {
  [[ $(val LM_DB_PASSWORD) =~ ^[0-9a-f]{48}$ ]]
  [[ $(val LM_JWT_SECRET) =~ ^[0-9a-f]{64}$ ]]
  [[ $(val LM_REALTIME_SECRET_KEY_BASE) =~ ^[0-9a-f]{128}$ ]]
  [[ $(val LM_REALTIME_DB_ENC_KEY) =~ ^[0-9a-f]{16}$ ]]
  local re='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' json='^[][{}":,A-Za-z0-9_.+/=-]+$'
  [[ $(val LM_ANON_KEY) =~ $re && $(val LM_SERVICE_KEY) =~ $re ]]
  [[ $(val LM_JWT_KEYS) == \[* && $(val LM_JWT_KEYS) =~ $json ]]
  [[ $(val LM_JWKS) == \{* && $(val LM_JWKS) =~ $json ]]
  setup_fixture
  rm -f "$ENV_DIR/app.env"
  run --separate-stderr bash "$LM_DEPLOY" staging app-env <"$OUT"
  [ "$status" -eq 0 ]
  cmp "$OUT" "$ENV_DIR/app.env"
}

@test "keys: anon and service_role JWTs are HS256 signed with LM_JWT_SECRET and carry the role" {
  local secret role jwt header payload sig want
  secret=$(val LM_JWT_SECRET)
  for role in anon service_role; do
    if [[ $role == anon ]]; then jwt=$(val LM_ANON_KEY); else jwt=$(val LM_SERVICE_KEY); fi
    IFS=. read -r header payload sig <<<"$jwt"
    [ "$(b64url_dec "$header")" = '{"alg":"HS256","typ":"JWT"}' ]
    want=$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$secret" -binary | base64 -w0 | tr '+/' '-_' | tr -d '=')
    [ "$sig" = "$want" ]
    local p
    p=$(b64url_dec "$payload")
    [[ $p =~ ^\{\"iss\":\"supabase\",\"role\":\"$role\",\"iat\":([0-9]+),\"exp\":([0-9]+)\}$ ]]
    # 有效期限 10 年。
    [ "$((BASH_REMATCH[2] - BASH_REMATCH[1]))" -eq 315360000 ]
  done
}

@test "keys: the ES256 private JWK matches the public JWK in LM_JWKS and signs verifiable signatures" {
  local priv jwks kid x y d
  priv=$(val LM_JWT_KEYS)
  jwks=$(val LM_JWKS)
  [[ $priv == '[{"kty":"EC","kid":"'* ]]
  [[ $priv == *'"use":"sig","alg":"ES256","ext":true,"crv":"P-256",'* && $priv == *'"key_ops":["sign","verify"]'* ]]
  kid=$(json_field "$priv" kid)
  [[ $kid =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
  x=$(json_field "$priv" x)
  y=$(json_field "$priv" y)
  d=$(json_field "$priv" d)
  [ "$(json_field "$jwks" kid)" = "$kid" ]
  [ "$(json_field "$jwks" x)" = "$x" ]
  [ "$(json_field "$jwks" y)" = "$y" ]
  [[ $jwks == *'"key_ops":["verify"]},{"kty":"oct","k":"'* ]]
  [[ $jwks != *'"d":'* ]]
  # oct 金鑰是 JWT secret 本身（base64url）。
  [ "$(b64url_dec "$(json_field "${jwks#*\"oct\"}" k)")" = "$(val LM_JWT_SECRET)" ]
  # 以 d、x、y 重建 SEC1 DER：openssl ec -check 驗證公鑰屬於私鑰，再以私鑰簽章、以公鑰驗證。
  local t=$BATS_TEST_TMPDIR hex
  [ "$(b64url_dec "$d" | wc -c)" -eq 32 ]
  [ "$(b64url_dec "$x" | wc -c)" -eq 32 ]
  [ "$(b64url_dec "$y" | wc -c)" -eq 32 ]
  hex="30770201010420$(b64url_dec "$d" | od -An -tx1 -v | tr -d ' \n')a00a06082a8648ce3d030107a14403420004$(b64url_dec "$x" | od -An -tx1 -v | tr -d ' \n')$(b64url_dec "$y" | od -An -tx1 -v | tr -d ' \n')"
  printf '%s' "$hex" | sed 's/../\\x&/g' | xargs -0 printf '%b' >"$t/key.der"
  openssl ec -inform DER -in "$t/key.der" -check -noout 2>&1 | grep -q 'EC Key valid'
  openssl ec -inform DER -in "$t/key.der" -pubout -out "$t/pub.pem" 2>/dev/null
  printf 'little-moments' >"$t/msg"
  openssl dgst -sha256 -sign "$t/key.der" -keyform DER -out "$t/sig" "$t/msg"
  openssl dgst -sha256 -verify "$t/pub.pem" -signature "$t/sig" "$t/msg" | grep -q 'Verified OK'
}

@test "keys: two runs produce different values for every key" {
  local second="$BATS_TEST_TMPDIR/second.env" k
  bash "$KEYS_TOOL" env prod >"$second"
  for k in "${KEYS[@]}"; do
    [ "$(val "$k")" != "$(sed -n "s/^$k=//p" "$second")" ]
  done
}

@test "keys: wrong arguments exit 2 and print nothing on stdout" {
  local a
  for a in "" "env" "env qa" "staging" "env staging extra"; do
    # shellcheck disable=SC2086
    run --separate-stderr bash "$KEYS_TOOL" $a
    [ "$status" -eq 2 ]
    [ -z "$output" ]
  done
}
