# OMO Native용 pi-kiro-provider 하드닝 현황

기준일: 2026-09-29

## 1. 저장소와 fork 현황

| 항목 | 상태 |
|---|---|
| Upstream | `MasuRii/pi-kiro-provider` |
| Fork | `JangHyuckYun/pi-kiro-provider` |
| Upstream 기준 | `0.2.2`, commit `35fc171e3bea` |
| Fork release line | `0.3.0-native.1` |
| 라이선스 | MIT |

이 fork의 기존 `main`은 작업 시작 시점에 upstream `main`과 ahead/behind `0/0`으로 동일했습니다. 기존에 다음 두 수정 브랜치가 있었습니다.

| Branch | 내용 | Upstream 상태 |
|---|---|---|
| `fix/api-key-tokentype-header` | `ksk_` API key에 `tokentype: API_KEY` 추가 | upstream PR #3 open |
| `fix/invalid-tool-use-format-pipe-id` | `call_id|continuation_id` 형식에서 primary tool ID만 Kiro에 전송 | 별도 PR 없음 |

이번 hardening은 위 두 수정과 로컬 OMO Native 5.1 호환성 작업을 하나의 설치 가능한 fork로 통합합니다.

## 2. 변경 전 로컬 상태

완성된 provider는 Git 저장소가 아니라 다음 로컬 경로에 존재했습니다.

- 활성 provider: `~/.omo/agent/npm/node_modules/pi-kiro-provider`
- durable source patch: `~/.omo/agent/npm/patches/pi-kiro-provider-0.2.2.patch`
- reapply hook: `~/.omo/agent/npm/scripts/patch-kiro-tokentype.mjs`
- regression harness: `~/.omo/agent/npm/scripts/kiro-native-compat.test.ts`

Upstream 0.2.2와 비교한 provider source 변경량은 4개 파일, `+332/-41`줄이었습니다.

| File | 핵심 변경 |
|---|---|
| `src/index.ts` | Native에서 빠질 수 있는 OAuth named export를 optional registration으로 처리 |
| `src/config.ts` | Opus 5.5, `max` thinking, compaction ratio/window metadata |
| `src/eventstream.ts` | JSON-array event payload 보존 |
| `src/kiro.ts` | schema, history, stream ordering, abort, diagnostics, retry, affinity 호환성 |

이 fork는 provider source를 직접 커밋합니다. 설치 시 upstream source에 대형 patch를 다시 적용하지 않습니다.

## 3. Provider 변경 상세

### 3.1 Model catalog

`claude-opus-5.5`:

- context window: `1,000,000`
- max output: `128,000`
- Kiro credit multiplier: `2.0`
- prompt cache checkpoint minimum: `512`
- thinking: `off=null`, `max=max`

모든 Kiro 모델은 별도 `config.json` 없이 다음 기본 metadata를 받습니다.

```json
{
  "compactionTriggerRatio": 0.8
}
```

개별 model 또는 `modelDefaults`의 유효한 `(0, 1]` 값으로 override할 수 있습니다.

### 3.2 Tool schema

Kiro Anthropic route는 tool의 root `inputSchema`에 `oneOf`, `anyOf`, `allOf`가 있으면 HTTP 400을 반환할 수 있습니다.

Provider boundary에서:

- root combinator를 제거
- object properties를 병합
- union은 모든 variant에 공통인 required field만 유지
- property constraint 충돌은 nested `anyOf`로 보존
- `allOf` required field는 합집합으로 처리

Argument object 형태는 유지하면서 금지된 root schema 형태만 제거합니다.

### 3.3 Message/history identity

- assistant의 text와 tool call이 함께 있을 때 text를 버리지 않음
- Native `affinitySessionId`를 Kiro conversation identity의 우선 입력으로 사용
- fallback identity에서 첫 user message 4,000자 truncation 제거
- 다른 provider가 만든 `call_id|continuation_id`는 primary ID로 정규화
- 동일 정규화가 assistant tool use와 tool result 양쪽에 적용됨

### 3.4 Event stream과 병렬 tool

- JSON array `toolUseEvent`를 object wrapper로 변환하지 않고 배열로 유지
- 16바이트 미만 또는 32MiB 초과의 잘못된 frame prefix는 1바이트씩 resync
- 정상적으로 끝나지 않은 plausible frame은 다음 chunk를 기다림
- tool input이 interleave되어도 Native에는 content block별 `start/delta/end` 순서로 전달
- upstream의 최초 등장 순서 `tool A -> text -> tool B`를 보존
- buffered text/thinking usage를 한 번만 계산
- anonymous tool ID가 기존 tool과 충돌하지 않도록 map size 기반 ID 사용

### 3.5 Request lifecycle

- credential 또는 preflight 실패 전에도 `start` event를 먼저 전송
- `onPayload`와 `onResponse` hook을 provider timeout/parent abort로 중단 가능
- listener와 timer를 `finally`에서 정리
- Native가 주입한 `fetch`를 사용 가능
- provider-owned timeout은 `abortSource: "provider"`

### 3.6 Error/retry metadata

- HTTP status를 Native `providerDiagnostic`으로 변환
- custom provider ID를 `errorMetadata.providerId`에 보존
- HTTP 429의 `retry-after-ms`, 정수 `retry-after`, HTTP-date를 `(retry-after-ms: N)` marker로 변환
- credential source별 refresh 가능 여부를 구분
- `ksk_` Kiro API key에만 `tokentype: API_KEY` 헤더 추가

## 4. OMO Native engine patch

### 목적

Provider model metadata의 `compactionTriggerRatio`를 OMO Native proactive compaction 경로가 사용하도록 합니다.

실제 model `contextWindow`는 변경하지 않습니다. 따라서:

- model capability와 status 표시 유지
- hard overflow 판정 유지
- output/reserve 정책 유지
- proactive compaction 시점만 변경

### 정확한 경계

Native `shouldCompact`의 reserve subtraction과 strict comparison을 역보정하는 threshold window를 계산합니다.

| Real context | Below | First trigger |
|---:|---:|---:|
| 1,000,000 | 799,999 | 800,000 |
| 64,000 | 51,199 | 51,200 |

`isContextOverflow(message, model.contextWindow)`는 원래 real context를 계속 사용합니다.

### 안전 장치

`scripts/patch-omo-native.mjs`:

- OMO `5.1.0` + senpi `2026.9.28-7`만 지원
- pristine/patched SHA-256 fingerprint 확인
- 정확한 call-site 개수 확인
- 결과 fingerprint와 JavaScript syntax 확인
- engine 옆 backup/receipt 생성
- same-directory temporary file 후 atomic rename
- lock file로 동시 실행 방지
- 알 수 없는 버전, fingerprint, 부분 패치, backup 충돌 시 무수정 실패
- patched 상태에서 재실행하면 byte-preserving no-op
- rollback은 현재/backup hash가 receipt와 일치할 때만 수행

Engine patch가 새로 적용되거나 복원되면 OMO 프로세스를 재시작해야 합니다. 이미 실행 중인 프로세스가 새 디스크 내용을 자동으로 로드했다고 간주하면 안 됩니다.

## 5. 설치

### OMO package 설정

`~/.omo/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/JangHyuckYun/pi-kiro-provider@<FULL_COMMIT_SHA>"
  ]
}
```

`npm:pi-kiro-provider`는 npm upstream을 설치하므로 이 fork를 사용하지 않습니다.

### 수동 설치

```bash
cd ~/.omo/agent/npm
npm install --save github:JangHyuckYun/pi-kiro-provider
cd node_modules/pi-kiro-provider
npm run check:native
```

Lifecycle script가 차단되었을 때:

```bash
npm run setup:native
npm run check:native
```

경로 자동 탐색이 모호한 경우:

```bash
PI_KIRO_SENPI_AGENT_SESSION=/absolute/path/to/agent-session.js \
  npm run setup:native
```

Postinstall patch를 의도적으로 생략하는 개발 환경:

```bash
PI_KIRO_SKIP_OMO_NATIVE_PATCH=1 npm install
```

이 옵션은 engine integration이 검증되지 않았다는 뜻이며 운영 준비 완료 증거가 아닙니다.

## 6. 인증과 로컬 설정

```text
/login kiro
```

Builder ID, Google, GitHub 방식을 사용할 수 있습니다.

로컬 설정이 필요할 때:

```bash
cp config/config.example.json config.json
```

`config.json`은 package 교체 시 보존을 보장하지 않는 package-local 파일입니다. credential은 저장하지 말고 OAuth/환경 credential 경로를 사용하십시오.

## 7. 업데이트

### Provider 업데이트

검증된 전체 Git SHA로 package reference를 갱신합니다.

```json
"git:github.com/JangHyuckYun/pi-kiro-provider@<NEW_FULL_COMMIT_SHA>"
```

재설치 후:

```bash
npm run check:native
```

### OMO 업데이트

OMO update는 provider postinstall을 재실행하지 않을 수 있습니다.

```bash
cd ~/.omo/agent/npm/node_modules/pi-kiro-provider
npm run setup:native
npm run check:native
```

지원하지 않는 새 engine에서는 실패가 정상입니다. fingerprint 검사를 우회하거나 source anchor를 느슨하게 바꾸지 말고, 새 버전용 compatibility profile과 fixture를 먼저 추가해야 합니다.

## 8. 롤백

### Engine

```bash
cd ~/.omo/agent/npm/node_modules/pi-kiro-provider
npm run restore:native
```

다음 경우 복원을 거부합니다.

- 현재 engine이 receipt의 patched hash와 다름
- backup이 receipt의 original hash와 다름
- 다른 patch revision의 receipt
- backup 또는 receipt 누락

### Provider

`settings.json`의 package reference를 이전 검증 SHA로 변경하거나 원본 `npm:pi-kiro-provider`로 되돌립니다.

Provider와 engine rollback은 별개입니다. 원본 provider를 사용할 경우 engine patch도 별도로 복원할지 판단해야 합니다.

## 9. 검증

### Repository

```bash
npm ci --ignore-scripts
npm run check
npm run package:dry-run
```

### Installed package

```bash
npm run check:native

OMO_CODING_AGENT_DIR="$HOME/.omo/agent" \
SENPI_CODING_AGENT_DIR="$HOME/.omo/agent" \
omo --list-models kiro
```

Fresh OMO session에서:

- Opus 5.5 선택
- `todo`, `read`, `lsp_symbols` 등 서로 다른 tool 호출
- schema/order 오류 부재
- 별도 Sonnet 4.6 session에서도 동일 확인

## 10. 2026-09-29 검증 근거

로컬 hardening 당시 관측:

- compatibility suite: 12 pass, 0 fail, 58 assertions
- production bundle: exit 0
- model catalog: Kiro 18개, Opus 5.5 정확히 1개
- Opus 5.5 fresh TUI: `todo`, `read`, `lsp_symbols` 성공
- Sonnet 4.6 fresh TUI: 동일 multi-tool 성공
- GPT 5.6 Sol fresh TUI: 실제 `read` 성공
- postinstall patcher: 2회 연속 exit 0, 두 번째 no-op
- owned QA process/window/listener cleanup 완료

이 저장소의 release 검증은 위 로컬 patch를 package source와 fixture로 이식한 뒤 다시 수행해야 합니다. 과거 증거만으로 GitHub package release가 검증되었다고 주장하지 않습니다.

## 11. 알려진 제한

1. 현재 compatibility profile은 OMO `5.1.0` / senpi `2026.9.28-7` 전용입니다.
2. macOS에서 검증했으며 Linux는 동일 경로 규칙을 지원하지만 release acceptance가 필요합니다. Windows는 미검증입니다.
3. Kiro compaction summary 요청이 HTTP 403으로 실패할 수 있습니다. 엔진은 fail-closed로 context를 버리지 않습니다.
4. cooldown 후 수동 `/compact` 재시도가 성공한 사례가 있으나 자동 성공을 보장하지 않습니다.
5. 한 개의 매우 큰 retained turn은 summary 후에도 policy threshold 이상일 수 있습니다.
6. 이 fork는 npm registry에 별도 배포되지 않았습니다.
7. OMO update 후 provider postinstall이 자동 재실행된다고 가정하면 안 됩니다.
