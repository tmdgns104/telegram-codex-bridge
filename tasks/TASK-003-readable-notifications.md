# TASK-003 — 구분 가능한 알림과 읽기 쉬운 결과

Status: VERIFIED — implementation acceptance PASS; publication pending
Baseline: 9ca42a60c816c61faa72bdfde5cb1bdc8f039b59
Date: 2026-09-09

## Problem / authorization

실제 수신 메시지 검토 후 사용자가 첫 개선 범위의 구현을 요청했다.
PC notify와 Telegram 제어 경로의 상태 표시, 불필요한 알림, 작업 구분,
짧은 결과와 전체 결과 접근을 개선한다. 기존 GitHub 게시 요청도 유지한다.
사용자 제공 메시지 파일은 로컬에 보존하고 게시·테스트 fixture·지식 기록에 복사하지 않는다.

## Requirements / architecture impact

- 기존 Python notify 진입점과 argv 계약을 보존한다. 내부 전달만 기존 필수 Node 런타임으로
  연결하여 Telegram 통신·결과 표시 코드를 공유한다. 새 서비스/DB/의존성/설정 변경은 없다.
- PC의 turn-complete는 작업 성공 증거가 아니므로 중립적인 응답 도착으로 표시한다.
  제목/요약 단일 필드 JSON은 출처를 확정할 수 없어 삭제하지 않는다. 조용한 참고 표시와
  원본 텍스트 제공으로 정상 JSON 결과를 보존한다. 일반 JSON에는 이 분류를 적용하지 않는다.
- 같은 봇/채팅/작업 경로/스레드/턴의 notify는 제한된 로컬 메타데이터로 중복 전송 시도를 막는다.
  본문·경로·토큰은 기록하지 않는다. 최근 24시간 이내 최대 1,000건만 보관하며 오래된 알림
  식별자는 지운다. 이 범위 밖의 중복 방지는 보장하지 않는다. 미확인 전송은 자동 재시도하지
  않는다. ID 없는 이벤트는 내용만으로 중복을 추정하지 않는다. 디스크 기록 동안만 기존 방식의
  OS 수명 loopback 잠금을 사용하여 동시 프로세스의 중복·보관 한도 경쟁을 막는다.
- 프로젝트명/짧은 작업 번호 및 PC 알림 전용과 브리지 제어 가능 여부를 구분한다.
  Telegram 답장은 현재 연결된 작업의 메시지로 확인될 때만 작업 입력으로 전달한다.
  다른 PC 세션·오래된 작업·알 수 없는 답장 대상은 명시적으로 거절한다.
- 긴 결과는 앞부분과 확인 관련 원문을 제한된 길이로 발췌하고 전체 결과로 접근할 수 있게 한다.
  의미를 새로 생성하거나 실패/미검증을 성공으로 바꾸지 않는다. 원본은 UTF-8로 보존한다.
- PC 알림은 긴 결과/제목·요약 JSON 원본을 메모리에서 생성한 텍스트 파일로 함께 제공한다.
  브리지는 최근 결과의 전체 보기 버튼과 /detail을 제공한다. 임의 로컬 파일을 읽거나 보내지 않는다.
- 모델 실행, 실제 Telegram 메시지 전송, 운영 봇 재시작은 이번 검증 범위에서 제외한다.

## Acceptance / verification (STRICT for reply routing)

1. 질문 답변/검토 대기/실패 내용의 PC 알림에 성공 단정을 붙이지 않음.
2. 제목·요약형과 일반 JSON 결과의 원본 보존. 상세 전송 실패를 성공으로 숨기지 않음.
3. 한글/emoji/긴 문서/로컬 인용 표식은 미리보기 길이를 지키고 전체 원본을 보존.
4. 같은 event 중복/동시 호출/ID 없음/다른 봇·프로젝트/보관 만료/한도/전송 미확인 처리 검증.
5. PC 알림·이전 작업 답장·만료 상세 버튼은 다른 turn/start, steer, 질문 답변을 발생시키지 않음.
6. Python notify 진입점 → Node 처리 → 통제된 Telegram HTTP의 통합 검증. 실제 네트워크 전송 없음.
7. 전체 check/test, 실제 app-server smoke, 스킬 validator 및 임시 설치 검증.
8. README/STATUS/Task/Evidence 갱신, 사용자 파일·비밀 제외 감사, commit/push 및 원격 SHA 확인.

## Checkpoint

기존 입력 직렬화와 알림/접수 분리는 REUSE. 전역 notify는 별도 출력 경로이므로 공통 표시를
이 경로에도 적용한다. 신규 아키텍처인 작업 예약·프로젝트 전환·영구 결과 기록은 다음 범위로 둔다.

구현 완료: 공통 미리보기/중립 상태, PC 참고 응답의 무음 표시 및 원본 파일, notify 중복 억제,
브리지 전체 원문 버튼·/detail, 답장 대상 검증과 첨부 미지원 안내. Python 진입점의 실제 자식
프로세스 → Node → 통제된 HTTP 검증에서 한글·emoji 원문 일치 및 4개 동시 호출 1회 전달을 확인했다.
기존 승인 지연 시험은 새 상세 버튼과 승인 버튼을 구분하도록 조정했고 승인 만료 검증은 유지했다.
프로젝트와 스킬 임시 설치본 모두 check 및 테스트 85/85 PASS. 실제 app-server smoke PASS.
스킬 2곳 validator PASS. Evidence: `evidence/TASK-003/verification.md`.
남음: 게시 감사/commit/push/원격 SHA 확인 및 허용된 Knowledge Capture.

## Result / acceptance

AC 1–7 PASS: 중립 표시, JSON 원문 보존, Unicode/전체 원문, 동시 알림 중복 억제,
잘못된 답장 대상 차단, native Python/Node 통합, 전체 회귀 및 스킬 설치 검증 완료.
AC 8: 문서/STATUS/Evidence 갱신 완료, 게시 확인 대기.
UNVERIFIED: 실제 Telegram 휴대폰 표시, 운영 브리지 재시작. 전체 원문은 결과 텍스트만 제공한다.
다음 독립 범위: 승인 정보 보강·설치 진단·실제 산출물/첨부·프로젝트/작업 관리. 자동 시작하지 않는다.
