import { AppServerClient } from "../src/app-server-client.mjs";

const codexBin = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.cmd" : "codex");
const client = new AppServerClient({ codexBin });
const timeout = setTimeout(() => {
  console.error("app-server 핸드셰이크 시간 초과");
  client.close();
  process.exitCode = 1;
}, 15_000);

try {
  await client.start();
  const result = await client.request("thread/start", {
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    ephemeral: true,
  });
  if (!result?.thread?.id) throw new Error("thread/start 응답에 thread.id가 없습니다.");
  console.log(`app-server 핸드셰이크 및 임시 thread/start 성공: ${result.thread.id}`);
} finally {
  clearTimeout(timeout);
  client.close();
}
