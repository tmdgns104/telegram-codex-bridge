import test from "node:test";
import assert from "node:assert/strict";
import { metadataShape, notificationPresentation, projectName, resultPreview } from "../src/result-presentation.mjs";

const event = (text, overrides = {}) => ({ type: "agent-turn-complete", cwd: "C:/synthetic/project-a",
  "thread-id": "thread-a", "turn-id": "turn-a", "last-assistant-message": text, ...overrides });

test("turn end never implies task success; same source has a stable visible identity", () => {
  for (const body of ["질문에 답했습니다.", "Human review required. Not deployed.", "필수 기준 실패", "성공했습니다."]) {
    const result = notificationPresentation(event(body));
    assert.match(result.text, /PC 응답 도착/);
    assert.doesNotMatch(result.text, /✅|PC Codex 작업 완료/);
    assert.match(result.text, /project-a[\s\S]*알림 전용/);
    assert.equal(result.body, body);
  }
  assert.equal(notificationPresentation(event("a")).id, notificationPresentation(event("b")).id);
  assert.notEqual(notificationPresentation(event("a")).id,
    notificationPresentation(event("a", { cwd: "C:/synthetic/project-b" })).id);
});

test("metadata-shaped JSON is quiet but never discarded; ordinary JSON stays ordinary", () => {
  for (const kind of ["title", "recap"]) {
    const body = JSON.stringify({ [kind]: "정상 사용자 JSON일 수도 있음" });
    const result = notificationPresentation(event(body));
    assert.equal(result.quiet, true);
    assert.equal(result.needsDetail, true);
    assert.equal(result.body, body);
    assert.match(result.text, /정상 사용자 JSON일 수도 있음/);
  }
  for (const body of ['{"title":"a","id":1}', '[{"title":"a"}]', '{"title":null}', '{broken']) {
    assert.equal(metadataShape(body), null);
    const result = notificationPresentation(event(body));
    assert.equal(result.body, body);
    assert.equal(result.quiet, false);
  }
});

test("long Unicode excerpts include late review caveats and retain the exact original", () => {
  const body = "# 결과\n\n자동 검사를 마쳤습니다.\n" + "지원 정보입니다.\n".repeat(60)
    + "실제 화면은 미검증이며 사용자 확인 필요\n" + "😀긴 문서 ".repeat(1000);
  const result = notificationPresentation(event(body));
  assert.equal(result.body, body);
  assert.equal(result.needsDetail, true);
  assert.match(result.text, /실제 화면은 미검증/);
  assert.ok(result.text.length < 1500);
  assert.equal(result.text.isWellFormed(), true);
  const emoji = resultPreview("😀".repeat(10000));
  assert.ok(emoji.text.length <= 1100);
  assert.equal(emoji.text.isWellFormed(), true);
});

test("desktop file references are presented as PC-only and originals remain available", () => {
  const body = '[보고서](<D:/synthetic/report.md>)\n:codex-file-citation{path="D:/synthetic/out.pdf" purpose="output"}';
  const result = notificationPresentation(event(body));
  assert.doesNotMatch(result.text, /codex-file-citation|D:\//);
  assert.match(result.text, /PC에서 확인/);
  assert.equal(result.body, body);
  assert.equal(result.needsDetail, true);
  assert.equal(projectName("C:\\synthetic\\project-a\\"), "project-a");
});

test("Markdown tables and web links remain readable without relying on Telegram Markdown parsing", () => {
  const body = "| 검사 | 결과 |\n|---|---|\n| 화면 | 미검증 |\n[근거](https://example.com/report)";
  const result = notificationPresentation(event(body));
  assert.match(result.text, /검사 · 결과/);
  assert.match(result.text, /화면 · 미검증/);
  assert.match(result.text, /근거: https:\/\/example.com\/report/);
  assert.doesNotMatch(result.text, /\|---/);
  assert.equal(result.body, body);
  assert.equal(result.needsDetail, true);
});
