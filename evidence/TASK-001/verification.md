# TASK-001 Verification — 2026-09-09

## Environment and scope

- Windows / Node v24.15.0 / codex-cli 0.153.4.
- 실제 Telegram 메시지 전송 없음. 실제 app-server 검사는 모델 호출 없이 읽기 전용
  임시 thread 생성까지만 수행했다.
- Git 이력 없음. 수정 전 백업:
  `%TEMP%/telegram-bridge-practical-20260909-082031` (작업 PC의 로컬 임시 디렉터리).
  백업 대상은 src/test/scripts/package.json/README.md/STOT.md이며 설정·대화 상태·로그는 제외했다.
- 최종 소스 식별: `source-sha256.json`.

## Observed results

| Check | Result | Evidence |
|---|---|---|
| 수정 전 전체 테스트 | 15/15 PASS | 수정 전 실행 관측 |
| 최종 구문 검사 | exit 0 | check.txt |
| 최종 전체 테스트 | 31/31 PASS | tests.txt |
| 실제 app-server initialize + ephemeral read-only thread/start | exit 0 | smoke.txt (로컬 보관) |
| 현재 CLI JSON Schema 생성 | exit 0 | `.schema/current/` (재생성 가능) |
| 수정 전 소스에 핵심 회귀 시험 적용 | 예상대로 0/3 PASS | 아래 재현 요약 |
| 전역/로컬 Skill quick_validate.py | 각각 valid | 실제 도구 실행 관측 |
| 전역 Skill의 새 임시 설치본 | check exit 0, 27/27 PASS | 아래 설치 경로 |

스키마는 `codex.cmd app-server generate-json-schema --experimental --out .schema/current`로
생성했다. `v2/ItemStartedNotification.json`의 `threadId`, `turnId`, `item.id`,
`item.type`과 활동 유형을 확인하여 상태 표시를 구현했다.

## Before/after regression

새 `test/bridge.test.mjs`를 수정 전 소스의 별도 복사본에서 다음 패턴으로 실행했다:
`node --test --test-name-pattern "PC와 Telegram의 동시 입력|시작 응답 전 완료|완료 알림 전송 실패 후 last" <copied-test>`.

1. 동시 입력 3개가 모두 `turn/start`를 호출했다(기대 1, 실제 3).
2. 완료 알림이 먼저 도착하면 이후 시작 응답이 active turn을 다시 설정했다.
3. 완료 알림 실패 뒤 `/last`는 알 수 없는 명령으로 반환됐다.

수정본은 동일 시험을 포함한 31개 테스트를 통과했다. 추가로 질문 버튼 중복 입력,
텍스트 답변 후 버튼 만료, 서버 해결/완료 후 대기 해제와 전송 중 해결 경쟁을 검증했다.

## Reusable package

- 기존 `connect-codex-telegram`에 접수와 전달의 분리, 입력 직렬화, 이벤트 순서 및
  버튼 경쟁 회귀 절차를 추가했다. 선별된 src/bridge.mjs, src/format.mjs,
  test/bridge.test.mjs와 명령 안내를 로컬·전역 스킬에 반영했다.
- 임시 설치본:
  `%TEMP%/telegram-skill-tracking-install-20260909-085731` (작업 PC의 로컬 임시 디렉터리).
- 기존 공유 ZIP은 과거 배포본으로 보존했다. 이번 갱신은 전역 스킬 및 폴더 템플릿에 적용된다.

## Limits

실제 Telegram UI와 네트워크 장애 재현은 UNVERIFIED다. 네트워크 실패·지연은 fake
Telegram으로 검증했다. `/last`는 재시작 후 결과를 복구하지 않는다. 브리지 프로세스
재시작 및 모델 작업 실행은 수행하지 않았다. 다음 운영 확인은 작업 완료 후 재시작과
사용자의 `/status`, `/last` 확인이다.

## GitHub publication

- 사용자 요청 대상: `https://github.com/tmdgns104/telegram-codex-bridge`.
- 기존 PUBLIC 저장소에 branch/commit이 없음을 `git ls-remote` 및 GitHub CLI로 확인했다.
- 최초 구현 커밋: `bdb32329357f7b42a8346da14359c5499935fd00`.
- 스테이징 58개 파일의 내용·확장자·크기를 확인했다. 실제 형식의 Telegram/GitHub/API
  토큰, 개인 키, 개인 홈 경로 패턴 탐지 결과 0건. 이는 패턴 검사 범위의 결과다.
- 제외 파일: 실제 설정, 대화 상태, 운영 로그, 개인 운영 이력, 과거 ZIP, 생성 스키마.
  로컬 파일은 보존했다. 새 저장소이므로 이전 커밋에서 제거할 자료는 없었다.
- `git push -u origin main` 성공 후 GitHub API에서 원격 SHA와 로컬 HEAD가 위 커밋으로
  일치함을 확인했다. 기본 branch main, PUBLIC, 원격 파일 58개, 제외 파일 0개,
  upstream origin/main, 작업 트리 clean을 관측했다.
- 이 게시 검증 기록은 후속 문서 커밋에 보관한다. 후속 변경은 문서에 한정된다.
