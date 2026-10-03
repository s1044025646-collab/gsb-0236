import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface ArchiveRow {
  id: number;
  source_path: string;
  sha256: string;
  total_bytes: number;
  entry_count: number;
  end_marker: string;
  diagnostics: string;
  imported_at: string;
}

export interface EntryRow {
  id: number;
  archive_id: number;
  idx: number;
  name: string;
  type: string;
  typeflag: string;
  size: number;
  header_offset: number;
  data_offset: number;
  sha256: string | null;
  unsupported_reason: string | null;
}

export interface PlanRow {
  id: number;
  archive_id: number;
  target_dir: string;
  items: string;
  status: string;
  error: string | null;
  created_at: string;
}

export interface ExtractionRow {
  id: number;
  plan_id: number;
  archive_id: number;
  target_dir: string;
  status: string;
  results: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "ustar-service.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        end_marker TEXT NOT NULL,
        diagnostics TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        typeflag TEXT NOT NULL,
        size INTEGER NOT NULL,
        header_offset INTEGER NOT NULL,
        data_offset INTEGER NOT NULL,
        sha256 TEXT,
        unsupported_reason TEXT,
        UNIQUE(archive_id, idx)
      );
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        target_dir TEXT NOT NULL,
        items TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extractions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
        target_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        results TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}
