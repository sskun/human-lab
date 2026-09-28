// SQLite 连接（node:sqlite，Node 22.5+，24 起无需实验开关，零第三方依赖）：
// 连接与建表收敛在这里，进程内单例；具体读写由 tasks/chat 两个仓库承担。
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ConfigService } from '../config.service.js';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private db!: DatabaseSync;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.config.dataDir, 'human-lab.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        text       TEXT,
        voice      TEXT,
        model      TEXT,
        file_path  TEXT,
        bytes      INTEGER,
        video_path TEXT,
        stage      TEXT,
        status     TEXT NOT NULL,
        error      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      -- 实时聊天：会话（点击「开始聊天」建一行，「结束聊天」写 ended_at）
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id         TEXT PRIMARY KEY,
        status     TEXT NOT NULL DEFAULT 'active',
        started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        ended_at   TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0
      );

      -- 实时聊天：每轮对话的输入/输出明细（ASR 文本、LLM 回复、双方音频归档）
      CREATE TABLE IF NOT EXISTS chat_turns (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        idx          INTEGER NOT NULL,
        input_type   TEXT NOT NULL,
        input_text   TEXT,
        output_text  TEXT,
        input_audio  TEXT,
        output_audio TEXT,
        input_bytes  INTEGER,
        asr_duration REAL,
        llm_usage    TEXT,
        status       TEXT NOT NULL DEFAULT 'processing',
        error        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
    this.migrate();
  }

  /**
   * 存量库迁移：早期版本的 tasks 表没有 video_path（口播视频产物）/ stage（流水线阶段）列，
   * 按 PRAGMA table_info 缺哪列补哪列（CREATE TABLE 只对全新库生效，这里兜住老库）。
   */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(tasks)').all() as Record<string, unknown>[]).map((r) =>
      String(r.name),
    );
    if (!cols.includes('video_path')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN video_path TEXT');
      console.log('[db] tasks 表迁移：已添加 video_path 列');
    }
    if (!cols.includes('stage')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN stage TEXT');
      console.log('[db] tasks 表迁移：已添加 stage 列');
    }
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }
}
