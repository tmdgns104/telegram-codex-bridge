# Telegram Codex Bridge

Telegram을 내 PC의 Codex `app-server`에 연결하는 개인용 브리지입니다.

- Telegram 메시지로 Codex 작업 시작
- 진행 중인 작업에 추가 지시 전달
- 명령 실행·파일 변경·추가 권한을 Telegram 버튼으로 승인 또는 거부
- Codex의 선택형·주관식 질문을 Telegram에서 답변
- 작업 완료·실패·중단 결과 수신
- 외부 포트를 열지 않는 Telegram long polling
- 하나의 `ALLOWED_CHAT_ID`만 허용
- 같은 봇 설정의 중복 실행을 시작 단계에서 자동 차단

## 요구 사항

- Node.js 20 이상
- 설치 및 로그인된 Codex CLI
- Telegram `@BotFather`가 발급한 봇 토큰

현재 PC에서는 PowerShell 실행 정책 때문에 `codex` 대신 `codex.cmd`를 사용합니다.

## 1. Telegram 봇 만들기

1. Telegram에서 `@BotFather`를 엽니다.
2. `/newbot`을 실행하고 봇 이름과 username을 정합니다.
3. 발급된 토큰을 안전하게 보관합니다.
4. 만든 봇과 대화를 열고 `/start`를 한 번 보냅니다.

## 2. 설정

`.env.example`을 `.env`로 복사합니다.

```powershell
Copy-Item .env.example .env
notepad .env
```

먼저 `TELEGRAM_BOT_TOKEN`만 입력한 뒤 chat ID를 확인합니다.

```powershell
npm.cmd run discover:chat-id
```

출력된 숫자를 `ALLOWED_CHAT_ID`에 넣고, Codex가 작업할 절대 경로를
`CODEX_WORKDIR`에 넣습니다.

```env
TELEGRAM_BOT_TOKEN=123456789:실제_토큰
ALLOWED_CHAT_ID=123456789
CODEX_WORKDIR=C:\projects\my-project
```

`.env`와 `.state.json`은 Git에서 제외됩니다.

## 3. 점검 및 실행

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run smoke:app-server
start.cmd
```

실행 후 Telegram에서 `/help`를 보냅니다.

## Telegram 명령

- 일반 메시지: 새 Codex 작업을 시작하거나 진행 중인 작업에 추가 지시
- `/status`: 현재 활동, 경과 시간, 승인·질문 대기 확인
- `/last`: 최근 완료·실패·중단 결과와 소요 시간 다시 보기
- `/new`: 새 Codex 스레드 생성
- `/cancel`: 진행 중인 turn 중단
- `/where`: 작업 경로와 권한 설정 확인
- `/help`: 도움말

## 보안 기본값

- Sandbox는 `workspace-write` 또는 `read-only`만 허용합니다.
- 승인 정책 `never`와 Sandbox `danger-full-access`는 설정 단계에서 거부합니다.
- 세션 전체 승인은 Telegram UI에 제공하지 않습니다.
- 추가 권한은 요청받은 범위 그대로 이번 turn에만 허용합니다.
- 승인 callback은 한 번 처리된 후 만료됩니다.
- 허용된 개인 chat ID 외의 메시지는 무시합니다.
- 같은 Bot 토큰과 chat ID로 이미 실행 중이면 두 번째 프로세스는 Telegram 연결 전에 종료됩니다.

Telegram 봇 채팅은 종단간 암호화가 아닙니다. API 키, 비밀번호, 복구 코드와
같은 비밀정보를 Codex 질문에 답변하는 방식으로 전송하지 마세요.

## 운영 참고

- PC가 켜져 있고 `start.cmd`가 실행 중이어야 합니다.
- 동시에 터미널 TUI와 Telegram에서 같은 스레드를 조작하지 않는 것을 권장합니다.
- 브리지가 마지막 `threadId`를 `.state.json`에 저장하고 다음 실행 때 재개합니다.
- `codex app-server`를 인터넷에 직접 노출하지 않습니다.
- `/last`는 가장 최근 결과 1건을 메모리에 보관합니다. 새 대화에서도 조회할 수
  있지만 브리지 재시작 시 지워집니다. 결과 본문은 `.state.json`에 저장하지 않습니다.
- `/status`는 요청 시 진행 상황을 보여줍니다. 승인·질문 대기이면 해당 메시지의
  버튼을 누르거나 질문에 답하세요. 질문 선택지에는 설명과 직접 답변 안내가 표시됩니다.

## PC에서 직접 시작한 Codex 작업 알림

Telegram에서 시작한 작업은 승인·질문·완료를 모두 봇에서 처리합니다. 별도의
Codex CLI에서 직접 시작한 작업도 전역 `notify` hook을 설정하면 완료 결과를
Telegram으로 받을 수 있습니다. 현재 공식 `notify` 이벤트는
`agent-turn-complete`만 지원하므로 직접 시작한 CLI 작업의 승인과 질문은 해당
터미널에서 처리해야 합니다.
