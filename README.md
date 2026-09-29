<div align="center">

# omon-kiro-provider - OMO Native hardened Kiro provider

[![License](https://img.shields.io/github/license/JangHyuckYun/omon-kiro-provider?style=for-the-badge)](LICENSE)
[![Upstream](https://img.shields.io/badge/upstream-MasuRii%2Fpi--kiro--provider-blue?style=for-the-badge)](https://github.com/MasuRii/pi-kiro-provider)
[![OMO Native](https://img.shields.io/badge/OMO%20Native-5.1.0-green?style=for-the-badge)](https://github.com/code-yeongyu/oh-my-openagent)

Kiro의 AWS CodeWhisperer 호환 스트리밍 API를 OMO Native에서 안정적으로 사용하기 위한 `pi-kiro-provider` 포크입니다. 이 fork의 이름은 `omon-kiro-provider`입니다.

</div>

## 상태와 출처

- 원본 프로젝트: [`MasuRii/pi-kiro-provider`](https://github.com/MasuRii/pi-kiro-provider)
- 이 포크: [`JangHyuckYun/omon-kiro-provider`](https://github.com/JangHyuckYun/omon-kiro-provider)
- 원본 기준 버전: `0.2.2`
- 포크 버전: `0.3.0-native.3`
- 검증 대상: OMO Native `5.1.0`, senpi `2026.9.28-7`
- npm의 `pi-kiro-provider` 이름은 여전히 원본 프로젝트를 가리킵니다. 이 포크는 GitHub 주소로 설치해야 합니다.

원본 기능과 MIT 라이선스를 유지하면서 OMO Native의 provider, tool, event-stream, diagnostics, compaction 계약에 맞춘 호환성 수정과 회귀 테스트를 추가했습니다.

자세한 변경 내용과 운영 절차:

- [OMO Native 하드닝·포크 현황·운영 문서](docs/OMO_NATIVE_HARDENING.ko.md)
- [변경 이력](CHANGELOG.md)

## 주요 변경

- `kiro/claude-opus-5.5`: 1M context, 128K output, 2.0x credit, adaptive/max thinking metadata
- 모든 Kiro 모델의 proactive compaction 기본값: 실제 context window의 정확히 80%
- top-level `oneOf` / `anyOf` / `allOf` tool schema를 Kiro 허용 object schema로 정규화
- JSON-array tool payload와 깨진 event-stream prefix 복구
- 병렬/interleaved tool event를 Native content-block 순서로 직렬화
- mixed assistant text + tool history, full conversation affinity, cross-provider pipe tool ID 정규화
- timeout/abort listener 정리, injected fetch, Native provider diagnostics, `Retry-After` marker
- 단일 credential의 일시적 HTTP 429를 Native cooldown 이전에 bounded retry
- Kiro API key의 `tokentype: API_KEY` 헤더
- OMO Native engine의 80% compaction 정책을 설치·검사·복원하는 fail-closed 도구

## OMO Native 설치

### 권장: settings.json에서 Git commit 고정

`~/.omo/agent/settings.json`의 `packages`에 다음 항목을 사용합니다.

```json
{
  "packages": [
    "git:github.com/JangHyuckYun/omon-kiro-provider@v0.3.0-native.3"
  ]
}
```

검증된 tag 또는 전체 commit SHA를 사용하십시오.

```json
"git:github.com/JangHyuckYun/omon-kiro-provider@<FULL_COMMIT_SHA>"
```

그 다음 OMO를 새로 시작합니다. 설치 lifecycle이 허용된 환경에서는 provider 설치 후 OMO Native engine compatibility patch가 자동 적용됩니다. 패치가 새로 적용되었다면 실행 중인 모든 OMO 프로세스를 종료하고 다시 시작해야 합니다.

### 수동 설치

```bash
mkdir -p ~/.omo/agent/npm
cd ~/.omo/agent/npm
npm install --save github:JangHyuckYun/omon-kiro-provider
```

설치 후 명시적으로 검사할 수 있습니다.

```bash
cd ~/.omo/agent/npm/node_modules/omon-kiro-provider
npm run check:native
```

Lifecycle script가 비활성화된 설치에서는 직접 적용합니다.

```bash
npm run setup:native
npm run check:native
```

## 지원 범위

현재 engine patch profile은 다음 조합만 fail-closed 방식으로 지원합니다.

| Component | Supported version |
|---|---:|
| `omo-ai` | `5.1.0` |
| `@code-yeongyu/senpi` | `2026.9.28-7` |
| Host | macOS 실사용 검증. Linux는 동일 경로 규칙을 지원하지만 실행 검증 전, Windows 미검증 |

알 수 없는 engine fingerprint, 다른 OMO/senpi 버전, 중복 engine 후보, 부분 패치 상태에서는 engine 파일을 수정하지 않고 오류를 반환합니다.

## 인증

Provider ID는 `kiro`입니다. OAuth provider는 다음 로그인 방식을 제공합니다.

- AWS Builder ID
- Google
- GitHub

OMO에서 `/login kiro`를 사용하거나, 기존 Kiro credential 관리 경로를 사용할 수 있습니다. 정적 `Authorization` header 설정은 의도적으로 제거됩니다.

## 설정

기본 설정만 사용할 때는 `config.json`이 필요하지 않습니다. 사용자 설정이 필요하면:

```bash
cp config/config.example.json config.json
```

중요 기본값:

```json
{
  "debug": false,
  "rateLimitMaxRetries": 3,
  "rateLimitRetryBaseMs": 30000,
  "rateLimitRetryMaxMs": 120000,
  "modelDefaults": {
    "compactionTriggerRatio": 0.8
  }
}
```

`config.json`은 로컬 전용이며 Git 및 package artifact에서 제외됩니다. credential이나 access token을 저장소에 커밋하지 마십시오.

## 검증

저장소 검증:

```bash
npm ci --ignore-scripts
npm run check
npm run package:dry-run
```

설치된 OMO Native 검증:

```bash
cd ~/.omo/agent/git/github.com/JangHyuckYun/omon-kiro-provider
npm run check:native

OMO_CODING_AGENT_DIR="$HOME/.omo/agent" \
SENPI_CODING_AGENT_DIR="$HOME/.omo/agent" \
omo --list-models kiro
```

목록에는 `claude-opus-5.5`가 정확히 한 번 표시되어야 합니다.

장시간 orchestrator 검증에는 Kiro를 main model로 선택한 fresh session에서
서로 다른 Native tool, 병렬 `task` batch, dependency-ordered mass-ulw DAG를
모두 실행합니다. 단순 model-list 또는 한 번의 text 응답은 release evidence가
아닙니다.

## OMO 업데이트

OMO 자체 업데이트는 provider package를 재설치하지 않을 수 있습니다. 업데이트 후:

```bash
cd ~/.omo/agent/git/github.com/JangHyuckYun/omon-kiro-provider
npm run setup:native
npm run check:native
```

검사가 통과한 뒤 OMO를 다시 시작합니다. 지원하지 않는 새 OMO/senpi 버전에서는 patcher가 실패하며, 새 compatibility profile이 추가되기 전까지 강제로 적용하면 안 됩니다.

## 롤백

Engine patch를 적용할 때 원본과 receipt가 engine 파일 옆에 생성됩니다. 현재 engine이 receipt의 patched hash와 일치할 때만 복원됩니다.

```bash
cd ~/.omo/agent/git/github.com/JangHyuckYun/omon-kiro-provider
npm run restore:native
```

Provider 자체는 `settings.json`에서 이전 Git SHA 또는 원본 npm package로 되돌립니다. Provider rollback과 engine rollback은 별개 작업입니다.

## 알려진 제한

- 이 포크는 npm에 별도 배포되지 않았습니다. `npm install pi-kiro-provider`는 원본을 설치합니다.
- 80% 도달 시 compaction은 시작되지만 Kiro summary 요청 자체가 HTTP 403을 반환할 수 있습니다. 엔진은 이 경우 fail-closed로 context를 버리지 않습니다.
- 한 개의 매우 큰 retained turn은 compaction 후에도 80% 이상을 유지할 수 있습니다.
- 429 retry는 bounded입니다. 기본 3회(30s, 60s, 120s) 후에도 Kiro가 계속
  거부하면 최종 429를 Native에 전달합니다.
- OMO/senpi 버전이 바뀌면 compatibility profile을 검토하고 갱신해야 합니다.

## Upstream Pi 설치

일반 Pi 환경과 upstream package가 필요하면 원본 저장소 문서를 사용하십시오.

```bash
pi install npm:pi-kiro-provider
```

## License

[MIT](LICENSE). 원본 저작권과 upstream 이력을 유지합니다.
