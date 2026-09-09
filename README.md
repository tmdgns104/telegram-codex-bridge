# Telegram Codex Bridge

PC의 Codex 작업을 휴대폰에서 확인하고 승인·답변·후속 작업·파일 전달까지 처리하는 개인용 브리지입니다.
PC는 켜져 있고 브리지가 실행 중이어야 합니다. Node 20+, 로그인된 Codex CLI, 개인 Telegram 봇이 필요합니다.
전역 완료 알림과 전체 테스트에는 Python 3.10+가 필요합니다.

## 처음 설정하기

1. Telegram의 `@BotFather`에서 봇을 만들고 만든 봇에 `/start`를 보냅니다.
2. `setup.cmd`를 실행해 봇 토큰(숨김 입력), 개인 chat ID, 프로젝트 경로를 입력합니다.
   chat ID 입력에서 Enter를 누르면 처음 연결한 개인 채팅 하나를 자동으로 찾습니다.
   여러 채팅이 있으면 `npm run discover:chat-id`로 확인한 ID를 입력합니다.
3. `npm run doctor`로 로그인·설정·봇 연결·설치 상태를 점검합니다. 토큰은 출력하지 않습니다.
4. 일반 PC Codex의 원격 승인도 사용하려면 Codex `/hooks`에서 새 Telegram PermissionRequest hook을 검토·신뢰합니다.
5. `start.cmd`를 실행하고 Telegram에서 `/menu`를 보냅니다.

기존 설치는 다음 명령으로 PC 승인 hook만 추가합니다. 기존 hook과 설정은 보존하고 백업합니다.

```powershell
npm.cmd run setup -- --install-hook --non-interactive
npm.cmd run doctor
```

`setup`은 정의를 설치할 뿐 Codex의 신뢰 상태를 변경하지 않습니다. 새 hook은 검토·신뢰 후 새 세션에서 사용하세요.
Codex 버전·실행 환경·승인 정책에 따라 hook 발생 여부가 다릅니다. 실제 승인 왕복은 초기 사용 때 확인하세요.
기존 전역 완료 알림 설정과 `scripts/codex-telegram-notify.py`의 호출 방식은 유지됩니다.

## 어디서 시작한 작업인가요?

| 시작 방법 | 휴대폰에서 할 수 있는 일 |
|---|---|
| Telegram 일반 메시지 | 작업 시작, 추가 지시, 승인·질문 답변, 결과·파일 조회 |
| PC `codex-tg.cmd "작업 내용"` | 같은 브리지 대화에서 작업, 승인·질문·결과를 Telegram으로 처리 |
| 일반 Codex + 신뢰된 PermissionRequest hook | 등록된 프로젝트의 지원되는 승인 요청을 Telegram에서 허용·거부 |
| 전역 `notify`만 연결된 PC 작업 | 응답 도착 알림과 원문 파일 수신 |

일반 PC 세션의 원격 승인은 **PermissionRequest hook** 경로입니다. 다른 app-server에서 PC 대화를 재개·복제하지 않습니다.
명령·파일 변경·MCP 등의 hook 지원 범위는 사용하는 Codex 버전에 따릅니다.
일반 PC 세션의 대화 질문과 후속 메시지 전달은 승인 hook의 계약에 포함되지 않습니다.
브리지 밖 PC 알림에 답장해 해당 대화를 조작하지 않으며, 지원되는 PC 승인에는 전용 버튼이 붙습니다.

공식 계약: [Codex PermissionRequest](https://learn.chatgpt.com/docs/hooks#permissionrequest),
[Codex App Server](https://learn.chatgpt.com/docs/app-server), [Telegram Bot API](https://core.telegram.org/bots/api).

## PC 승인 요청 처리

프로젝트·작업 번호·도구·요청 내용과 만료 시간이 표시됩니다.
`이번 요청 허용`, `거부`, `요청 전체 내용`을 사용하세요. 브리지에서 시작한 파일 변경 승인은
제공받은 변경 경로와 diff도 표시합니다. 정보가 없으면 없다고 알립니다.

- native PC 요청은 최대 5분 대기하며 살아 있는 요청의 결정만 한 번 전달합니다.
- 미등록 프로젝트·전송 실패·연결 끊김·시간 만료에는 허용 결정을 만들지 않고 기존 PC 승인 흐름으로 돌아갑니다.
- 기존 Codex 승인 정책과 다른 hook의 거부 결정은 유지됩니다. 이 기능은 자동 승인기가 아닙니다.
- `/projects`에서 허용 프로젝트 확인, `/project add D:\projects\example`로 등록합니다.
- 명령 인자에 알려진 비밀 형식이 보이면 PC 처리로 돌립니다. 모든 비밀을 탐지하는 기능은 아닙니다.

## 일상 사용

`/menu`에 주요 버튼이 있습니다. 진행 중 일반 메시지는 현재 작업의 추가 지시입니다.
**별도의 다음 작업**은 `/queue add 테스트를 실행하고 결과를 정리해줘`로 등록합니다.

| 명령 | 용도 |
|---|---|
| `/status` | 현재 활동·경과 시간·승인·질문·대기열 상태 |
| `/pending` | 놓친 승인 버튼과 질문 다시 받기 |
| `/last`, `/detail` | 최근 결과 미리보기 / 전체 원문 파일 |
| `/history`, `/history 2` | 현재 프로젝트의 저장된 결과 목록 / 해당 원문 |
| `/history clear` | 저장된 모든 프로젝트의 결과 기록 삭제 |
| `/projects`, `/project 2` | 등록 목록 / 프로젝트 선택 |
| `/project add 절대경로` | 프로젝트와 native 승인 대상 경로 등록 |
| `/project remove 번호` | 현재 선택하지 않은 프로젝트의 등록·해당 결과 기록 제거 |
| `/queue add 작업 내용` | 별도 작업을 대기열에 넣고 실행 가능할 때 시작 |
| `/queue pause`, `/queue run` | 다음 작업 시작 일시정지 / 재개 |
| `/queue drop 번호` | 아직 시작하지 않은 대기 작업 제거 |
| `/files`, `/file outputs/report.pdf` | 최근 산출물 목록 / 파일 직접 받기 |
| `/new` | 현재 프로젝트의 새 대화 |
| `/cancel` | 현재 작업 중단 요청 및 대기열 일시정지 |
| `/reconnect` | 연결 재설정과 상태 복구; 진행 중 작업이 중단될 수 있음 |
| `/where`, `/help` | 현재 경로·승인 정책 / 도움말 |

프로젝트는 최대 30개 등록합니다. 진행 중 작업·대기열·질문이 있으면 프로젝트 전환을 막습니다.
대기열은 최대 10건, 작업당 16,000자입니다. 실패·중단·연결 불명확 시 멈추며 `/queue run`으로 재개합니다.
재시작하면 대기열은 사라지며 과거 작업을 자동으로 재실행하지 않습니다.

답장은 현재 작업에 연결된 메시지만 입력 대상으로 받습니다. 다른 PC 알림·이전 작업·재시작 전 메시지에 대한
답장은 차단합니다. 답장 없이 보내는 메시지는 현재 선택된 프로젝트에 전달됩니다.

## 사진·문서·음성과 산출물

사진 또는 PDF·Office·텍스트 문서, OGG·MP3·WAV·M4A 음성을 보내고 캡션에 요청을 적습니다.
이미지·음성은 Codex의 `localImage`·`localAudio` 입력으로, 문서는 수신 경로를 읽는 요청으로 전달됩니다.
실제 해석은 Codex 모델과 로컬 도구 지원에 달려 있습니다. 지원되지 않는 입력은 오류를 알립니다.
영상은 지원하지 않습니다. 민감한 질문 대기 중에는 첨부로 답변받지 않습니다.

파일당 최대 10MB입니다. 수신 파일은 프로젝트 `.telegram-inbox/`에 임의 이름으로 저장됩니다.
새 첨부 수신 때 24시간 지난 생성 파일을 정리하며 최근 파일 합계는 최대 100MB입니다. Git에서 제외합니다.
첨부 원본이 오래 필요하면 PC에서 별도로 보관하세요. 파일은 자동 실행하거나 압축 해제하지 않습니다.

`/files`는 2단계 하위 폴더까지 최대 600개 항목에서 최근 지원 파일 12개를 표시합니다.
파일을 누르거나 `/file 상대경로`로 요청해야 업로드합니다. 프로젝트 밖 경로, 숨김·비밀 설정,
심볼릭 링크·하드 링크, 실행 파일은 보내지 않습니다. 생성 중인 파일은 완료 후 다시 요청하세요.
전체 원문 버튼은 응답 텍스트이고 산출물 버튼은 실제 파일 목록입니다.

## 결과와 저장 범위

모바일 미리보기는 발췌이며 자동 의미 요약이 아닙니다. 전체 원문에서 문맥과 미검증 항목을 확인하세요.
`Codex 응답 완료`는 응답이 끝났다는 뜻이며 모든 요구사항이 성공했다는 판정은 아닙니다.

- `.state.json`: 최근 thread와 경로. 기존 thread-only 형식도 읽습니다.
- `.bridge-data/workspace.json`: 등록 프로젝트·선택·프로젝트별 thread, 최근 결과 최대 30건/7일/4MB.
  결과 하나가 256KB를 넘으면 줄여 저장하지 않고 현재 메모리와 `/detail`에서만 제공합니다.
  기간은 조회·저장 시 적용합니다. `/history clear`는 저장 기록을 지우며 현재 `/last`는 유지합니다.
- 승인 본문·결정과 실행 대기열은 디스크에 보존하지 않습니다. 재시작 전 승인 버튼은 만료됩니다.
- 전역 PC 완료 알림은 제목/요약형 JSON을 무음 참고 알림으로 표시하고 JSON 원문을 보존합니다.
  긴 결과는 발췌와 원문 파일로 전달하며 짧은 일반 답변은 메시지 하나로 보냅니다.
- `.notify-dedup/`: 봇·채팅·경로·thread·turn 해시/시간만 최근 24시간·최대 1,000건 저장합니다.
  만료·한도 밖 또는 ID 없는 이벤트는 중복 억제를 보장하지 않습니다. 전송 불명확 시 자동 재전송하지 않습니다.

로컬 설정·수신 파일·결과 저장소는 Git에서 제외합니다. Telegram 봇 채팅은 종단간 암호화가 아닙니다.
비밀번호·API 키는 PC에서 설정하세요. 허용된 chat ID만 처리하고 세션 전체 승인 버튼은 제공하지 않습니다.
Sandbox는 read-only/workspace-write, 승인 정책은 untrusted/on-request를 사용합니다.

## 진단과 복구

`npm run doctor`는 실제 봇 인증과 chat 조회만 수행하며 메시지를 보내지 않습니다.
`--offline`은 Telegram API 조회를 생략하고 `--json`은 결과를 구조화합니다.
hook 정의 설치와 사용자 신뢰·실제 왕복은 다른 검증 단계입니다.

`codex-tg.cmd --status [접수번호]`는 PC 제출의 접수 여부를 확인합니다. 응답 유실 시 같은 ID로 한 번 재확인하며,
재시작 뒤 이전 접수 번호로 작업을 재실행하지 않습니다. 진행 상태와 결과는 `/status`, `/last`로 확인하세요.

기존 작업을 마친 뒤 브리지를 종료하고 `start.cmd`로 다시 실행하면 새 코드가 적용됩니다.
같은 봇의 두 번째 브리지는 차단합니다. PC 전역 notify는 다음 호출부터 새 코드를 사용합니다.
통신 시간 제한은 작업 실행 제한이 아닙니다. `/reconnect`는 상태를 읽으며 원래 요청을 다시 실행하지 않습니다.

## 구조와 개발 검증

`src/index.mjs`가 Telegram long polling, `bridge.mjs`, owned stdio app-server를 연결합니다.
`local-control.mjs`는 인증된 loopback의 PC 제출과 native 승인을, `native-approvals.mjs`는 요청 수명·버튼을,
`workspace-store.mjs`는 프로젝트·결과를, `files.mjs`는 수신/산출물 경계를 담당합니다.
외부 포트·새 서비스·추가 npm 의존성이 필요하지 않습니다.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run smoke:app-server
```

테스트는 합성 입력과 모의 Telegram을 사용하며 모델 작업이나 실제 메시지를 보내지 않습니다.
hook 테스트는 실제 Node 진입점과 인증된 loopback 왕복을 포함합니다. 실제 Codex smoke는 별도 읽기 전용
임시 thread로 연결을 확인합니다. hook 신뢰, 실제 모바일 버튼과 모델의 첨부 해석은 별도 실사용 확인입니다.
`STATUS.md`, `tasks/`, `evidence/`가 현재 구현·검증의 기준입니다. 개인 운영 이력과 수신 메시지 원본은 공개하지 않습니다.
