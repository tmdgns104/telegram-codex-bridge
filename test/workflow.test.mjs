import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../src/workspace-store.mjs";
import { readArtifact, listArtifacts, receiveAttachment, MAX_FILE_BYTES } from "../src/files.mjs";
import { writeSettings, envFileValues, installPermissionHook } from "../src/setup.mjs";

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-workflow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("project registry and bounded exact results survive restart without storing a queue", (t) => {
  const root = folder(t), project = path.join(root, "project");
  fs.mkdirSync(project);
  const options = { directory: path.join(root, "state"), workdir: project, now: () => 1000 };
  const store = new WorkspaceStore(options);
  const other = path.join(root, "other"); fs.mkdirSync(other);
  store.register(other); store.select(other); store.setThread("thread-other");
  assert.equal(store.isAllowed(root), false);
  assert.equal(store.isAllowed(other), true);
  const original = "한글 🐈\r\n실패 기준 확인 필요";
  store.addResult({ workdir: other, threadId: "thread-other", turnId: "turn-a", text: original });
  const loaded = new WorkspaceStore(options);
  assert.equal(loaded.selected.threadId, "thread-other");
  assert.equal(loaded.results()[0].text, original);
  assert.equal(loaded.results(project).length, 0);
  for (let i = 0; i < 35; i++) loaded.addResult({ workdir: other, turnId: String(i), text: "response" });
  assert.equal(loaded.results().length, 30);
  assert.equal(new WorkspaceStore({ ...options, now: () => 8 * 86400_000 }).results().length, 0);
  assert.equal(loaded.addResult({ workdir: other, turnId: "huge", text: "a".repeat(256 * 1024 + 1) }), false);
  assert.equal(JSON.parse(fs.readFileSync(loaded.file, "utf8")).queue, undefined);
});

test("artifact downloads retain bytes and reject traversal, hidden credentials, directories and size overflow", (t) => {
  const root = folder(t);
  fs.writeFileSync(path.join(root, "report.pdf"), Buffer.from("%PDF-synthetic\r\n"));
  fs.writeFileSync(path.join(root, ".env"), "synthetic");
  assert.equal(readArtifact(root, "report.pdf").bytes.toString(), "%PDF-synthetic\r\n");
  assert.equal(readArtifact(root, "./report.pdf").bytes.toString(), "%PDF-synthetic\r\n");
  assert.throws(() => readArtifact(root, "../report.pdf"));
  assert.throws(() => readArtifact(root, ".env"));
  assert.throws(() => readArtifact(root, path.join(root, "report.pdf")));
  assert.throws(() => readArtifact(root, "report.pdf:secret"));
  fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(MAX_FILE_BYTES + 1));
  assert.throws(() => readArtifact(root, "large.txt"));
  assert.deepEqual(listArtifacts(root).map((f) => f.path), ["report.pdf"]);
  fs.linkSync(path.join(root, "report.pdf"), path.join(root, "linked.pdf"));
  assert.throws(() => readArtifact(root, "linked.pdf"));
});

test("attachment paths are generated, typed and bounded independently of supplied filenames", async (t) => {
  const root = folder(t);
  const telegram = { async downloadFile() { return Buffer.from("synthetic bytes"); } };
  for (const [field, media, expected] of [
    ["photo", [{ file_id: "photo" }], "localImage"],
    ["voice", { file_id: "voice" }, "localAudio"],
    ["document", { file_id: "document", file_name: "../../report.pdf" }, "text"],
  ]) {
    const received = await receiveAttachment({ message: { [field]: media }, telegram, workdir: root });
    assert.equal(received.input.type, expected);
    assert.equal(path.dirname(received.file), path.join(root, ".telegram-inbox"));
    assert.equal(fs.readFileSync(received.file, "utf8"), "synthetic bytes");
  }
  await assert.rejects(receiveAttachment({ message: { document: { file_id: "x", file_name: "run.exe" } }, telegram, workdir: root }));
  await assert.rejects(receiveAttachment({ message: { photo: [{ file_id: "x", file_size: MAX_FILE_BYTES + 1 }] }, telegram, workdir: root }));
  assert.equal(fs.readFileSync(path.join(root, ".telegram-inbox/.gitignore"), "utf8"), "*\n");
});

test("directory links cannot redirect artifact reads or inbox writes outside the project", async (t) => {
  const root = folder(t), project = path.join(root, "project"), outside = path.join(root, "outside");
  fs.mkdirSync(project); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.txt"), "must stay outside");
  fs.symlinkSync(outside, path.join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readArtifact(project, "linked/private.txt"));
  fs.symlinkSync(outside, path.join(project, ".telegram-inbox"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(receiveAttachment({ message: { photo: [{ file_id: "synthetic" }] },
    telegram: { async downloadFile() { return Buffer.from("image"); } }, workdir: project }));
  assert.deepEqual(fs.readdirSync(outside), ["private.txt"]);
});

test("setup preserves unrelated settings and hook handlers, is idempotent, and never writes hook trust", (t) => {
  const root = folder(t), file = path.join(root, ".env");
  fs.writeFileSync(file, "# manual\nCUSTOM_VALUE=keep\nALLOWED_CHAT_ID=old\n");
  writeSettings(file, { ALLOWED_CHAT_ID: "123" });
  assert.equal(envFileValues(file).CUSTOM_VALUE, "keep");
  assert.match(fs.readFileSync(file, "utf8"), /# manual/);
  assert.throws(() => writeSettings(file, { ALLOWED_CHAT_ID: "123\nBAD=value" }));
  const hook = { hooks: { Stop: [{ hooks: [{ type: "command", command: "synthetic-stop" }] }], PermissionRequest: [{ hooks: [{ type: "command", command: "synthetic-deny" }] }] } };
  fs.writeFileSync(path.join(root, "hooks.json"), JSON.stringify(hook));
  const args = { codexHome: root, bridgeRoot: process.cwd() };
  assert.equal(installPermissionHook(args).changed, true);
  assert.equal(installPermissionHook(args).changed, false);
  const installed = JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8"));
  assert.deepEqual(installed.hooks.Stop, hook.hooks.Stop);
  assert.deepEqual(installed.hooks.PermissionRequest[0], hook.hooks.PermissionRequest[0]);
  assert.equal(installed.hooks.PermissionRequest.length, 2);
  assert.equal(fs.existsSync(path.join(root, "hook-trust.json")), false);
});
