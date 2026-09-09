# TASK-004 — PC와 휴대폰을 잇는 실사용 흐름

Status: VERIFIED — implementation checks PASS; publication/activation pending
Baseline: c05833281ef8f34a2cae40e0dd5540e8aacf9ae7
Authorization: 2026-09-09, PC 원격 승인 구조 변경 제안에 이어 사용자가 나머지 개선 전부 진행을 요청함.

## Problem → requirements

완료 알림만으로는 외출 중 승인이 막힌 PC 작업을 계속할 수 없다. 승인 판단 정보,
설치 진단, 입력/산출물 전달, 프로젝트 선택, 후속 작업 대기열과 재시작 후 결과 조회도 필요하다.
TASK-001–003 이력은 보존하며, 아래 항목을 하나의 원격 작업 흐름으로 완성한다.

1. 일반 PC Codex의 PermissionRequest 훅 → 인증된 로컬 브리지 → Telegram 일회 승인/거부 → 원래 호출 응답.
   타임아웃·통신 끊김·잘못된 버튼은 허용으로 해석하지 않는다. 전역 hook 신뢰를 우회하지 않는다.
2. 승인 요청의 명령·위치·사유·파일 변경 목록/차이와 추가 접근 범위를 보여주고 긴 원문은 별도 조회.
3. 초기 설정 도우미와 doctor: 설정/런타임/로그인/봇 연결/브리지 버전·hook 설치 상태를 비밀 출력 없이 진단.
4. 사진/문서/음성 수신과 캡션을 Codex 입력으로 연결. 설치된 프로토콜의 이미지/오디오 입력 사용,
   문서는 제한된 로컬 수신 폴더에서 읽도록 전달. 지원되지 않는 모델/입력 실패를 명시한다.
5. 사용자가 요청한 프로젝트 내 산출물 목록·다운로드. 경로 탈출·비밀 설정·과도한 크기 차단,
   모델이 언급한 파일을 자동 업로드하지 않는다.
6. 등록된 프로젝트 선택, 명시적 다음 작업 대기열, 최근 결과 기록과 재조회. 실행 중 프로젝트 변경 차단,
   실패/연결 불명 시 대기열 정지, 재시작으로 과거 작업 자동 재실행 금지.
7. 간단한 버튼 메뉴와 명령 도움말, README/스킬/검증 근거, GitHub 게시, 허용된 Obsidian 기록.

## Architecture / contracts

기존 Node/Telegram long polling과 owned stdio app-server를 유지한다. 새 외부 서비스/유료 API/DB 의존성 없음.
기존 인증된 loopback에 native permission 요청/결정 수명만 추가한다. PC hook은 stdin JSON을 받는
별도 Node 진입점이며 Telegram polling을 중복 실행하지 않는다. 다른 Codex 세션을 resume해서 가로채지 않는다.
기존 전역 hook과 config는 보존하여 병합하며, 아직 신뢰되지 않은 hook은 사용자 UI에서 신뢰 확인이 필요하다.

프로젝트 등록·선택과 제한된 결과는 Git 제외된 .bridge-data에 저장한다. 승인 본문과 결정은 메모리 한정,
대기열도 재시작 시 재실행하지 않는다. 첨부는 등록된 프로젝트 내 한정 폴더에 크기/보관 한도를 적용한다.
새 입력 경로도 기존 채팅 인증, 비밀 질문 차단, 답장 대상 및 실행 직렬화를 통과한다.

## Verification (STRICT)

- 기존 85개 회귀 + native hook/동시 승인/취소/만료/연결 끊김/잘못된 callback/다른 프로젝트 부작용 테스트.
- 승인 diff/원문, 사진·문서·오디오 입력, 다운로드 크기·경로 검증, queue 실패정지, 프로젝트 전환/재시작 이력.
- setup/doctor 격리 실행, 실제 Python/Node 프로세스 및 loopback 통합, 실제 Codex 프로토콜 smoke.
- 실제 Codex hook 실행은 합성 입력·격리 설정으로 검증 가능한 범위를 확보한다. 공식 문서 지원을
  실제 Telegram 휴대폰/모델 실행 PASS로 바꾸지 않는다. 필요한 실제 사용자 신뢰/화면 조작은 명시한다.
- 전체 check/test, 스킬 validator 및 임시 설치, 게시 파일 감사와 원격 SHA 확인.

## Checkpoint

설계/범위 확정. 기존 입력 직렬화와 일회 callback은 REUSE, 단일 결과/프로젝트 메모리 구조는 ADAPT.
공식 PermissionRequest hook은 허용/거부/기존 승인 흐름 유지 계약을 제공한다.
현재 CLI 0.153.4에서 hooks feature stable/true와 localAudio/localImage 입력 스키마 확인.
구현 및 자동검증 완료: native 승인/전체 요청 내용, setup/doctor, 사진·문서·음성/산출물,
등록·선택·제거 가능한 프로젝트, 명시적 대기열, 최근 결과 기록과 버튼 메뉴.
프로젝트와 임시 설치본 check 및 104/104 테스트 PASS. 실제 Codex smoke와 두 스킬 validator PASS.
실제 봇 인증·채팅 조회 성공. PC 승인 hook 정의를 별도 hooks.json에 설치하여 기존 config/notifier는 보존함.
남음: 게시 감사/commit/push/SHA 확인. 운영 활성화는 사용자 hook 신뢰와 브리지 실행이 필요하며,
휴대폰의 실제 승인 왕복과 모델의 첨부 해석은 UNVERIFIED. Evidence: evidence/TASK-004/verification.md.
