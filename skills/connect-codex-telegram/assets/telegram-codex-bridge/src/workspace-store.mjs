import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class WorkspaceStore {
  constructor({ directory, workdir, now = Date.now }) {
    this.directory = directory;
    this.file = path.join(directory, "workspace.json");
    this.now = now;
    this.initialWorkdir = fs.realpathSync(workdir);
    this.data = { version: 1, selected: this.initialWorkdir, projects: [{ path: this.initialWorkdir, name: path.basename(workdir), threadId: null }], history: [] };
    if (fs.existsSync(this.file)) {
      if (fs.lstatSync(this.file).isSymbolicLink() || fs.statSync(this.file).size > 5 * 1024 * 1024) throw new Error("작업 기록 파일을 확인하세요.");
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.projects) || !Array.isArray(value.history) ||
          !value.projects.length || value.projects.length > 30 ||
          !value.projects.every((p) => typeof p.path === "string" && path.isAbsolute(p.path) && typeof p.name === "string") ||
          !value.projects.some((p) => p.path === value.selected)) throw new Error("작업 기록 형식이 올바르지 않습니다. 원본을 보존하고 doctor로 확인하세요.");
      this.data = value;
    }
    this.prune();
  }

  get selected() { return this.data.projects.find((p) => p.path === this.data.selected); }
  get projects() { return this.data.projects; }
  isAllowed(cwd) {
    try {
      const actual = fs.realpathSync(cwd);
      return this.projects.some((p) => inside(p.path, actual));
    } catch { return false; }
  }

  register(directory) {
    if (!path.isAbsolute(directory)) throw new Error("프로젝트는 절대 경로로 등록하세요.");
    const actual = fs.realpathSync(directory);
    if (!fs.statSync(actual).isDirectory()) throw new Error("프로젝트 디렉터리가 아닙니다.");
    const existing = this.projects.find((p) => p.path === actual);
    if (existing) return existing;
    if (this.projects.length >= 30) throw new Error("프로젝트는 최대 30개까지 등록할 수 있습니다.");
    const project = { path: actual, name: path.basename(actual), threadId: null };
    this.projects.push(project);
    this.save();
    return project;
  }

  select(directory) {
    if (!this.projects.some((p) => p.path === directory) || !fs.statSync(directory).isDirectory()) throw new Error("등록된 프로젝트를 찾을 수 없습니다.");
    this.data.selected = directory;
    this.save();
  }
  remove(directory) {
    if (directory === this.data.selected) throw new Error("현재 프로젝트는 제거할 수 없습니다. 먼저 다른 프로젝트를 선택하세요.");
    this.data.projects = this.projects.filter((p) => p.path !== directory);
    this.data.history = this.data.history.filter((r) => r.workdir !== directory);
    this.save();
  }
  setThread(threadId) { this.selected.threadId = threadId; this.save(); }
  results(directory = this.data.selected) { this.prune(); return this.data.history.filter((r) => r.workdir === directory); }
  addResult(result) {
    // Oversized originals remain in the live bridge; do not silently truncate an archive.
    if (Buffer.byteLength(result.text) > 256 * 1024) return false;
    const { detailToken, ...record } = result;
    this.data.history = this.data.history.filter((r) => r.workdir !== record.workdir || r.turnId !== record.turnId);
    this.data.history.unshift({ ...record, recordedAt: this.now() });
    this.prune();
    this.save();
    return true;
  }
  prune() {
    this.data.history = this.data.history.filter((r) => typeof r.text === "string" &&
      typeof r.workdir === "string" && Number.isFinite(r.recordedAt) && this.now() - r.recordedAt < 7 * 86400_000).slice(0, 30);
    while (Buffer.byteLength(JSON.stringify(this.data)) > 4 * 1024 * 1024 && this.data.history.length) this.data.history.pop();
  }
  clearHistory() { this.data.history = []; this.save(); }
  save() {
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error("기록 폴더는 링크일 수 없습니다.");
    const ignore = path.join(this.directory, ".gitignore");
    if (fs.existsSync(ignore) && fs.lstatSync(ignore).isSymbolicLink()) throw new Error("기록 폴더의 제외 파일이 링크입니다.");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", { flag: "wx" });
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, this.file);
  }
}
