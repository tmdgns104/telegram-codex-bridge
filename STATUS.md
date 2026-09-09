# Telegram Codex Bridge — Current Status

Updated: 2026-09-09
Current Task: [TASK-002](tasks/TASK-002-reliable-user-flow.md)
Status: COMPLETE — acceptance PASS; GitHub publication verified
Repository: https://github.com/tmdgns104/telegram-codex-bridge (public, main)

TASK-002: 연결 종료/미확인 상태, `/pending`, `/reconnect`, PC 접수 번호/조회,
비밀 질문 차단을 구현했다. check 및 테스트 61/61 PASS, 실제 Codex handshake와
합성 대화의 조회/종료/재시작/재개/보관 검사 PASS. 스킬 설치본도 61/61 PASS.

- Evidence: [TASK-002 verification](evidence/TASK-002/verification.md)
- Published: 구현 커밋 `a29bb8f`; GitHub main과 로컬 HEAD 일치 확인.
- UNVERIFIED: 실제 Telegram 왕복과 운영 브리지 재시작. 실제 모델 작업은 실행하지 않음.
- Next: 운영 작업 종료 시 브리지 재시작 및 `/status`, `/pending`, PC `--status` 사용자 확인.

아래는 완료된 TASK-001의 기준 상태다.

`/status`에서 활동·시간·승인·질문 대기를 확인하고 `/last`로 최근 결과를 다시 본다.
PC/Telegram 입력을 순서대로 처리하며, 빠른 완료·알림 실패·오래된 질문 버튼에 대한
상태 오류를 수정했다. 최근 결과는 프로세스 메모리에만 저장한다.

- 검증: Node v24.15.0, codex-cli 0.153.4; check PASS, 테스트 31/31 PASS,
  실제 read-only 임시 thread smoke PASS.
- 재사용: 기존 전역 스킬 템플릿·검증 절차 갱신 및 임시 설치 테스트 27/27 PASS.
- [Evidence](evidence/TASK-001/verification.md)
- UNVERIFIED: 실제 Telegram 왕복, 실행 중 브리지에 적용. 기존 프로세스와 봇 설정은 수정하지 않음.
- Next: 기존 작업 종료 후 브리지 재시작 및 `/status`, `/last` 사용자 확인.

이번 작업 시작 시 Git 이력은 없었다. 사용자 지정 GitHub 저장소에 최초 게시를 완료하고
원격/로컬 커밋 일치, main 추적, 제외 파일 부재를 검증했다(구현 커밋 `bdb3232`).
현재 작업과 검증은 이 파일과 Task/Evidence가 기준이며, 기존 `STOT.md`는
개인 환경 정보가 포함된 로컬 운영 이력으로 GitHub에서 제외한다.
