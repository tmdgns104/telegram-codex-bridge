import { AppServerClient } from "../src/app-server-client.mjs";

const codexBin = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.cmd" : "codex");
const client = new AppServerClient({ codexBin });
const verifyRecovery = process.argv.includes("--recovery");
let testThreadId;
const timeout = setTimeout(() => {
  console.error("app-server 핸드셰이크 시간 초과");
  void client.close();
  process.exitCode = 1;
}, 15_000);

try {
  await client.start();
  const result = await client.request("thread/start", {
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    ephemeral: !verifyRecovery,
  });
  if (!result?.thread?.id) throw new Error("thread/start 응답에 thread.id가 없습니다.");
  testThreadId = result.thread.id;
  if (verifyRecovery) {
    // Materialize synthetic history without starting a model turn.
    await client.request("thread/inject_items", {
      threadId: testThreadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic recovery fixture. No task is requested." }] }],
    });
    const history = await client.request("thread/turns/list", {
      threadId: testThreadId, limit: 1, sortDirection: "desc", itemsView: "full",
    });
    if (!Array.isArray(history.data)) throw new Error("thread/turns/list 응답에 data가 없습니다.");
    await client.close();
    await client.start();
    await client.request("thread/resume", {
      threadId: testThreadId, cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "on-request",
    });
    console.log("최근 작업 조회 및 app-server 재연결/스레드 재개 성공");
  }
  console.log(`app-server 핸드셰이크 및 임시 thread/start 성공: ${result.thread.id}`);
} finally {
  clearTimeout(timeout);
  if (verifyRecovery && testThreadId) {
    try {
      await client.request("thread/archive", { threadId: testThreadId });
      console.log("검증용 대화 보관 처리 완료");
    } catch {
      console.error(`검증용 대화 보관 미완료: ${testThreadId}`);
      process.exitCode = 1;
    }
  }
  await client.close();
}
