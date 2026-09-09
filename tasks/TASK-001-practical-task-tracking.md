# TASK-001 — 실용적인 작업 추적과 입력 안정성

Status: COMPLETE — local acceptance PASS; live Telegram rollout UNVERIFIED
Date: 2026-09-09

## Problem / Requirements

사용자 요청: 이 프로젝트를 실용적으로 개선한다. 현재 `/status`는 turn ID만
표시하고, 완료 알림을 다시 조회할 수 없다. PC 입력과 Telegram 입력이 겹치면
동시에 `turn/start`를 호출할 수 있다.

## Architecture / Scope

기존 Telegram long polling → bridge → app-server stdio 구조 안에서 수정한다.
작업 추적은 bridge 메모리에만 보관하며 `.state.json`의 threadId 계약은 유지한다.
승인 정책, 허용 chat ID, 로컬 인증, 네트워크 바인딩, 전역 Codex 설정은 변경하지 않는다.
새 의존성, 프로젝트 전환, 서비스 설치, 실제 Telegram 메시지 전송은 범위 밖이다.

## Acceptance Criteria

1. `/status`: 작업 시작 중/진행 중/승인 대기/질문 대기/대기를 구분하고,
   경과 시간과 현재 활동을 표시한다. 다른 turn의 지연 이벤트는 상태를 바꾸지 않는다.
2. `/last`: 최근 완료·실패·중단 결과와 소요 시간을 다시 제공한다.
   결과는 현재 프로세스 메모리에만 남고, 완료 전/재시작 후에는 명확히 안내한다.
3. PC와 Telegram의 동시 입력은 순서대로 처리하여 시작 1회와 추가 지시로 전달한다.
   한 요청의 실패가 뒤 요청을 막지 않는다. 완료 이벤트가 시작 응답보다 먼저 와도
   완료된 작업이 다시 진행 중으로 표시되지 않는다.
4. 작업 접수 후 Telegram 알림 실패는 이미 접수된 작업의 실패로 반환하지 않는다.
   승인·질문 대기 표시는 응답/해결/완료 시 정리된다.
5. README의 명령·일상 사용 안내를 갱신하고 기존 테스트와 새 회귀 테스트가 통과한다.
   설치된 Codex의 스키마와 read-only 임시 thread smoke로 연결 호환성을 확인한다.

## Baseline / Verification

- Git 저장소 없음. 기존 문서 `STOT.md`와 구현이 기준이며 이전 이력을 보존한다.
- Node v24.15.0 / codex-cli 0.153.4.
- 수정 전: `npm.cmd test` 15/15 PASS, `npm.cmd run check` PASS,
  `npm.cmd run smoke:app-server` PASS.
- 최종: 같은 명령 + 지연 응답/동시 입력/알림 실패/상태 전이 회귀 테스트.
- 실제 Telegram 왕복 및 실행 중 브리지 재시작은 UNVERIFIED로 별도 구분한다.

## Result

- AC 1 PASS: 상태/활동/시간/승인·질문 대기, 다른 turn 이벤트 무시를 fake 이벤트로 검증.
- AC 2 PASS: 완료·실패·중단 결과 재조회와 시간 표시, threadId-only 저장을 검증.
- AC 3 PASS: 동시 입력은 `turn/start` 1회 + `turn/steer` 2회. 실패 후 다음 요청 처리,
  시작 응답 전 완료, 시작 중 PC 입력에 대한 상태 조회와 취소 순서를 검증.
- AC 4 PASS: 접수 알림의 실패/지연이 접수 응답을 실패시키지 않음. 질문 옵션 설명,
  텍스트 답변/해결/완료 후 버튼 정리, 동시 두 번 누름, 늦은 승인 버튼 도착을 검증.
- AC 5 PASS: `npm.cmd run check` exit 0, `npm.cmd test` 31/31 PASS,
  `npm.cmd run smoke:app-server` exit 0. README 및 `/help` 갱신.
- 수정 전 소스의 격리 복사본에 회귀 테스트 3개를 적용했을 때 모두 실패했다.
  동시 입력은 시작 요청 3회, 빠른 완료는 active turn 복원, `/last`는 미지원이었다.
  같은 시험은 수정본에서 모두 통과했다.
- 기존 전역 `connect-codex-telegram`의 문서와 선별된 bridge/format/test 템플릿 갱신.
  로컬·전역 스킬 validator PASS, 새 임시 설치본 check PASS, 테스트 27/27 PASS.
- 구조/안전 경계: 기존 stdio, long polling, loopback 인증, 승인 정책 유지. 의존성 추가 없음.
- UNVERIFIED: 실제 Telegram 송수신과 기존 프로세스 재시작. 이번 요청에서 메시지 전송은
  수행하지 않았고 운영 중 세션을 종료하지 않았다. 모델 작업 실행도 없음.
- Evidence: `evidence/TASK-001/verification.md`, `check.txt`, `tests.txt`, `smoke.txt`, `source-sha256.json`.
- Next: 사용자가 진행 중 작업을 마친 뒤 기존 브리지 종료 → `start.cmd` → `/status`, `/last` 확인.
  다음 독립 개발 Task는 자동 시작하지 않는다.

## 사용자 추가 요청 — GitHub 게시

- 대상: `https://github.com/tmdgns104/telegram-codex-bridge`. 사용자의 명시적인 게시 요청에 따라 실행했다.
- 대상은 기존 공개 저장소이며 원격 커밋이 없었다. 로컬 `main`을 초기화하고
  기존 구현과 이번 변경을 함께 최초 커밋 `bdb3232`로 게시했다.
- 58개 파일의 스테이징 내용을 검사했다. `.env`, 상태 파일, 로그, ZIP, 개인 운영 이력,
  생성 스키마는 게시하지 않았다. 커밋 이메일에는 GitHub noreply 주소를 사용했다.
- 게시 후 GitHub API로 원격 SHA와 로컬 SHA 일치, 공개 상태, 기본 branch main,
  원격 파일 58개와 제외 파일 부재를 확인했다. 로컬은 `origin/main`을 추적한다.
- 게시 검증 기록은 별도 문서 커밋으로 보존한다. 실제 봇 운영 검증 범위는 위와 동일하다.
