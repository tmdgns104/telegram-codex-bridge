# TASK-002 — 사용자가 복구할 수 있는 작업 접수와 대기 요청

Status: COMPLETE — implementation and local acceptance PASS; publication pending
Baseline: 0e18843715996005ea9c35b54893714ffdc2ef31
Date: 2026-09-09

## Problem / user authorization

사용자는 연결 종료, 승인·질문 전송 실패, PC 입력 중복과 비밀 질문 차단 개선안을
설명받은 뒤 “사용자 입장에서의 편의성을 생각하면서, 개선을 진행”하도록 요청했다.
기존 GitHub 게시 요청도 유지한다. TASK-001과 Evidence는 보존한다.

## Requirements and design

- `/status`는 연결 끊김/접수 미확인을 진행 중과 구분하고 다음 행동을 안내한다.
- `/reconnect`는 사용자가 요청한 연결 재설정이다. 기존 app-server를 정리한 뒤
  기존 thread를 재개하고 상태를 읽는다. 이전 작업은 자동 재실행하지 않는다.
  진행 중 작업이 끊길 수 있음을 명령 안내에 명시한다.
- `/pending`은 놓친 승인·질문을 다시 보낸다. 같은 RPC 요청의 중복 버튼은 모두
  한 번만 유효하다. 해결/완료/연결 종료 시 폐기하며 전송 실패 후에도 복구 가능하다.
- 통신 응답에는 제한 시간을 두지만 Codex 작업 수행 시간에는 제한을 두지 않는다.
  전송 후 응답 유실은 실패 확정이 아닌 미확인이다. 미확인 상태에서 새 작업을 차단한다.
- PC CLI는 접수 번호와 조회 방법을 제공한다. 기존 인증 loopback에 hello/submit/status를
  추가하며 기존 prompt 계약을 유지한다. 인스턴스 ID + 요청 ID로 현재 실행 중 중복 접수를
  방지하고, 재시작 후 이전 인스턴스 요청은 거절한다. 시간 초과 때도 같은 식별자만 재사용한다.
- 접수 메타데이터는 제한된 메모리에 보관한다. 원문 저장/새 DB/전역 설정 변경은 없다.
- 비밀 질문은 전송 전에 전체 요청을 명시적으로 거절하고 사용자에게 PC 설정을 안내한다.
  후속 일반 텍스트가 실수로 비밀 답변으로 전달되지 않도록 새 대화 전까지 입력을 차단한다.

## Architecture boundaries

기존 long polling / stdio / loopback 인증 / 단일 허용 chat / 요청 범위 승인 유지.
위 additive 로컬 인터페이스와 복구 명령은 사용자가 진행 요청한 개선안의 범위다.
새 서비스, 의존성, 프로젝트 전환, 자동 권한 승인, 원문 영구 저장은 추가하지 않는다.
실제 Telegram 메시지 전송과 운영 봇 프로세스 재시작은 수행하지 않는다.

## Acceptance / verification (STRICT for recovery and authorization)

1. 정상 종료·비정상 종료·RPC 시간 초과·늦은 응답 후 대기 정리; 작업 재실행 0회.
2. 알림 실패/재시도/재조회/중복 버튼/전송 중 해결 시 RPC 응답 최대 1회.
3. PC 접수 응답이 느린 Codex 응답을 기다리지 않음. 동일 ID는 실행 1회,
   다른 본문/이전 인스턴스/잘못된 인증/알 수 없는 ID는 안전하고 명확한 결과.
4. 비밀 질문 내용과 합성 비밀 답변을 Telegram/Codex로 보내지 않음.
5. HTTP 제한 시간, 중단 시 poll 취소, 일시 장애 재시도 횟수 제한 검증.
6. README/CLI help와 상태 문구의 다음 행동이 구현과 일치. 기존 테스트 모두 통과.
7. 최종 check/test 및 실제 read-only ephemeral app-server smoke; 전역 스킬의
   선별된 템플릿 갱신과 임시 설치 검증. 비밀 파일 제외 후 commit/push/원격 SHA 확인.

## Checkpoint

- 문제와 기존 코드 확인, 구현 범위 확정. 변경 전 작업 트리 clean.
- 과거 노트의 입력 직렬화 및 전달 실패 분리는 REUSE, 일반 모델 Timeout 원인 분석은
  이번 통신 접수 문제에 직접 적용되지 않아 REJECT. 이전 검증을 이번 PASS로 사용하지 않는다.
- Next: 통신 클라이언트 lifecycle → bridge 복구/대기 요청 → PC 접수 → 검증/문서/게시.

## 구현 체크포인트

- 통신 lifecycle, 명시적 복구, 재전송 가능한 대기 요청, 비밀 질문 차단, PC 접수/조회 구현.
- 기존 prompt 계약을 유지하고 CLI에 새 receipt 흐름을 적용했다. 인증된 hello/submit/status,
  인스턴스+요청 ID, 원문 없는 제한된 메모리 기록을 사용한다.
- Telegram polling이 RPC 완료를 기다리지 않도록 dispatch하며, 아직 전달되지 않은 질문에
  후속 텍스트가 답변으로 소비되는 것을 차단한다.
- 실제 CLI에서 ephemeral thread의 이력 조회 거절, 빈 persistent thread의 미저장 상태를
  관측했다. 사용하지 않은 대화는 재연결 시 새로 준비한다. 기존 작업이 있는 대화는 복구
  실패를 새 대화 생성으로 우회하지 않는다.
- 실제 복구 검사: 검증용 별도 대화에 합성 이력만 주입한 뒤 조회·종료·재시작·재개·보관
  처리 PASS. 모델 turn/start와 실제 Telegram 전송은 실행하지 않았다.
- 최종 검사, 스킬 임시 설치 검증, 문서/Evidence, commit/push/원격 확인을 남겨 둠.

## Result / Evidence

- AC 1 PASS: 응답 시간 초과와 정상/비정상/signal 종료 모두 pending RPC를 정리한다.
  미확인 상태에서 후속 작업을 차단하고 명시적 재연결 시 조회/재개만 수행함을 검증했다.
- AC 2 PASS: 실패한 승인·질문 전송을 `/pending`으로 복구하고 중복 버튼의 RPC 응답은
  1회로 제한했다. 해결·완료·연결 종료 후 만료와 전송 지연 경쟁을 검증했다.
- AC 3 PASS: 실제 loopback 요청/CLI로 즉시 접수, 조회, 동일 ID 중복 차단, 다른 본문 거부,
  이전 인스턴스 거부, 인증 거부, 메모리 한도, 응답 유실 후 동일 식별자 재시도를 검증했다.
- AC 4 PASS: 비밀 질문 일괄 거절과 후속 Telegram/PC 텍스트 차단, 새 대화의 차단 해제를
  합성 입력으로 검증했다. 비밀 질문 본문은 Telegram 전송 대상에 들어가지 않는다.
- AC 5 PASS: HTTP timeout, poll abort, 제한된 재시도, 429 대기 시간, 영구 오류를 검증했다.
- AC 6 PASS: 실제 CLI help/접수/조회 출력과 Telegram 응답성을 검증했다.
  최종 전체 테스트 61/61 PASS, 구문 검사 PASS. 기존 테스트 유지.
- AC 7 PASS (local): 기본 smoke와 실제 별도 합성 대화 조회/종료/재시작/재개/보관 smoke PASS.
  두 스킬 validator PASS, 설치본 check 및 테스트 61/61 PASS.
- Evidence: `evidence/TASK-002/verification.md`, `tests.txt`, `check.txt`, `source-sha256.json`.
- UNVERIFIED: 실제 Telegram 왕복, 운영 브리지 재시작, 실제 모델 작업 실행. 이번 검증은
  모델 turn을 생성하지 않았다. 상태 복구 시 알 수 없는 과거 소요 시간은 확인 불가로 표시한다.
- 원문/접수 메타데이터를 영구 저장하지 않는다. 인스턴스가 바뀌거나 새 요청 번호를 만든
  별도 사용자 명령까지 중복을 방지한다고 주장하지 않는다.
- Next: 안전한 게시 및 원격 SHA 확인. 이후 기존 운영 작업 완료 → 브리지 재시작 →
  `/status`, `/pending`, PC `--status` 사용자 확인. 다음 독립 Task를 자동 시작하지 않는다.
