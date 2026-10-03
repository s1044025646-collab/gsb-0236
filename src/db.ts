// SQLite 持久化：归档摘要、条目、解包计划与执行结果。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { TarEntry } from "./tar";
import { AppError } from "./errors";

export interface ArchiveRow {
  id: number;
  source_path: string;
  sha256: string;
  size: number;
  entry_count: number;
  diagnostics: string; // JSON 数组
  status: string;
  created_at: string;
}

export class Store {
  db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        diagnostics TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'imported',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id INTEGER NOT NULL REFERENCES archives(id),
        idx INTEGER NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        header_offset INTEGER NOT NULL,
        data_offset INTEGER NOT NULL,
        sha256 TEXT
      );
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id INTEGER NOT NULL REFERENCES archives(id),
        target_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        executed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        entry_idx INTEGER NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sha256 TEXT,
        error TEXT
      );
    `);
  }

  createArchive(sourcePath: string, sha256: string, size: number, diagnostics: string[], entries: TarEntry[]): number {
    // 事务：先完整写入，任一失败则整体回滚，不留半份结果
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare("INSERT INTO archives (source_path, sha256, size, entry_count, diagnostics) VALUES (?,?,?,?,?)")
        .run(sourcePath, sha256, size, entries.length, JSON.stringify(diagnostics));
      const archiveId = Number(r.lastInsertRowid);
      const stmt = this.db.prepare(
        "INSERT INTO entries (archive_id, idx, path, type, size, header_offset, data_offset, sha256) VALUES (?,?,?,?,?,?,?,?)"
      );
      for (const e of entries) {
        stmt.run(archiveId, e.index, e.path, e.type, e.size, e.headerOffset, e.dataOffset, e.sha256);
      }
      this.db.exec("COMMIT");
      return archiveId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getArchive(id: number): ArchiveRow {
    const row = this.db.prepare("SELECT * FROM archives WHERE id = ?").get(id) as ArchiveRow | undefined;
    if (!row) throw new AppError("E_NOT_FOUND", `归档 ${id} 不存在`, 404);
    return row;
  }

  listArchives(): ArchiveRow[] {
    return this.db.prepare("SELECT * FROM archives ORDER BY id").all() as unknown as ArchiveRow[];
  }

  listEntries(archiveId: number) {
    this.getArchive(archiveId);
    return this.db.prepare("SELECT * FROM entries WHERE archive_id = ? ORDER BY idx").all(archiveId);
  }

  createPlan(archiveId: number, targetDir: string, items: { entryIdx: number; path: string; type: string; targetPath: string }[]): number {
    this.db.exec("BEGIN");
    try {
      const r = this.db.prepare("INSERT INTO plans (archive_id, target_dir) VALUES (?,?)").run(archiveId, targetDir);
      const planId = Number(r.lastInsertRowid);
      const stmt = this.db.prepare(
        "INSERT INTO plan_items (plan_id, entry_idx, path, type, target_path) VALUES (?,?,?,?,?)"
      );
      for (const it of items) stmt.run(planId, it.entryIdx, it.path, it.type, it.targetPath);
      this.db.exec("COMMIT");
      return planId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getPlan(id: number) {
    const plan = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as any;
    if (!plan) throw new AppError("E_NOT_FOUND", `计划 ${id} 不存在`, 404);
    const items = this.db.prepare("SELECT * FROM plan_items WHERE plan_id = ? ORDER BY id").all(id);
    return { ...plan, items };
  }

  listPlans(archiveId?: number) {
    if (archiveId !== undefined) {
      return this.db.prepare("SELECT * FROM plans WHERE archive_id = ? ORDER BY id").all(archiveId);
    }
    return this.db.prepare("SELECT * FROM plans ORDER BY id").all();
  }

  markPlanExecuting(id: number) {
    this.db.prepare("UPDATE plans SET status = 'executing' WHERE id = ?").run(id);
  }

  finishPlan(id: number, ok: boolean, error?: string) {
    this.db
      .prepare("UPDATE plans SET status = ?, error = ?, executed_at = datetime('now') WHERE id = ?")
      .run(ok ? "done" : "failed", error ?? null, id);
  }

  setItemStatus(itemId: number, status: string, sha256?: string | null, error?: string) {
    this.db
      .prepare("UPDATE plan_items SET status = ?, sha256 = ?, error = ? WHERE id = ?")
      .run(status, sha256 ?? null, error ?? null, itemId);
  }

  close() {
    this.db.close();
  }
}
