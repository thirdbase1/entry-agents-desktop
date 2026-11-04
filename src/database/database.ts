/**
 * Local SQLite persistence for Entry Desktop — follows OpenCode's
 * `packages/core/src/database/database.ts` & `schema.gen.ts`.
 *
 * Uses `bun:sqlite` with OpenCode's exact WAL & performance pragmas:
 * - PRAGMA journal_mode = WAL
 * - PRAGMA synchronous = NORMAL
 * - PRAGMA busy_timeout = 5000
 * - PRAGMA cache_size = -64000
 * - PRAGMA foreign_keys = ON
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AccountRow {
  id: string;
  email: string;
  url: string;
  access_token: string;
  refresh_token: string;
  token_expiry: number | null;
  plan: string | null;
  plan_name: string | null;
  credit_balance_cents: number;
  time_created: number;
  time_updated: number;
}

export interface ProjectRow {
  id: string;
  worktree: string;
  vcs: string | null;
  branch: string | null;
  name: string;
  time_created: number;
  time_updated: number;
}

export interface SessionRow {
  id: string;
  project_id: string;
  slug: string;
  directory: string;
  title: string;
  agent: "build" | "plan" | "explore" | "general";
  model_id: string | null;
  version: string;
  summary_additions: number;
  summary_deletions: number;
  summary_files: number;
  verified: number;
  verification_summary: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  agent: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  part_type: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface ArtifactRow {
  id: string;
  session_id: string;
  title: string;
  kind: "architecture" | "plan" | "diff" | "markdown" | "verification";
  file_path: string | null;
  content: string;
  time_created: number;
  time_updated: number;
}

export interface ScheduleRow {
  id: string;
  project_id: string;
  name: string;
  cron: string;
  prompt: string;
  agent: "build" | "plan";
  enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  time_created: number;
  time_updated: number;
}

export class EntryDesktopDatabase {
  readonly db: Database;
  readonly dbPath: string;

  constructor(customPath?: string) {
    const defaultDir = join(homedir(), ".entry", "desktop");
    this.dbPath =
      customPath ??
      process.env.ENTRY_DESKTOP_DB_PATH ??
      join(defaultDir, "entry-desktop.sqlite");
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new Database(this.dbPath, { create: true });
    this.configurePragmas();
    this.migrate();
  }

  private configurePragmas(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA cache_size = -64000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA temp_store = MEMORY;");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        url TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        token_expiry INTEGER,
        plan TEXT,
        plan_name TEXT,
        credit_balance_cents INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
        active_org_id TEXT
      );

      INSERT OR IGNORE INTO account_state (id, active_account_id, active_org_id)
      VALUES (1, NULL, NULL);

      CREATE TABLE IF NOT EXISTS credential (
        provider_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL UNIQUE,
        vcs TEXT,
        branch TEXT,
        name TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'build',
        model_id TEXT,
        version TEXT NOT NULL DEFAULT '1.0.0',
        summary_additions INTEGER NOT NULL DEFAULT 0,
        summary_deletions INTEGER NOT NULL DEFAULT 0,
        summary_files INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        verification_summary TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_session_project ON session_v2(project_id, time_updated DESC);

      CREATE TABLE IF NOT EXISTS session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'build',
        model_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_message_session ON session_message(session_id, time_created ASC);

      CREATE TABLE IF NOT EXISTS session_part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES session_message(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
        part_type TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_part_message ON session_part(message_id, time_created ASC);
      CREATE INDEX IF NOT EXISTS idx_part_session ON session_part(session_id, time_created ASC);

      CREATE TABLE IF NOT EXISTS permission (
        project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT,
        content TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_session ON artifact(session_id, time_updated DESC);

      CREATE TABLE IF NOT EXISTS schedule (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'build',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_status TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        time_updated INTEGER NOT NULL
      );
    `);
  }

  // ---- KV helpers ---------------------------------------------------------

  getKv<T = unknown>(key: string): T | null {
    const row = this.db
      .query("SELECT value FROM kv WHERE key = ?")
      .get(key) as { value: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setKv(key: string, value: unknown): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO kv (key, value, time_updated)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, time_updated = excluded.time_updated`,
      )
      .run(key, JSON.stringify(value), now);
  }

  // ---- Account & Auth persistence ----------------------------------------

  upsertAccount(
    account: Omit<AccountRow, "time_created" | "time_updated">,
  ): AccountRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO account (
          id, email, url, access_token, refresh_token, token_expiry,
          plan, plan_name, credit_balance_cents, time_created, time_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          url = excluded.url,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          token_expiry = excluded.token_expiry,
          plan = COALESCE(excluded.plan, account.plan),
          plan_name = COALESCE(excluded.plan_name, account.plan_name),
          credit_balance_cents = excluded.credit_balance_cents,
          time_updated = excluded.time_updated`,
      )
      .run(
        account.id,
        account.email,
        account.url,
        account.access_token,
        account.refresh_token,
        account.token_expiry,
        account.plan,
        account.plan_name,
        account.credit_balance_cents,
        now,
        now,
      );

    this.db
      .query("UPDATE account_state SET active_account_id = ? WHERE id = 1")
      .run(account.id);

    return this.getActiveAccount()!;
  }

  getActiveAccount(): AccountRow | null {
    const row = this.db
      .query(
        `SELECT a.* FROM account a
         JOIN account_state s ON s.active_account_id = a.id
         WHERE s.id = 1`,
      )
      .get() as AccountRow | null;
    if (row) return row;
    return (
      (this.db
        .query("SELECT * FROM account ORDER BY time_updated DESC LIMIT 1")
        .get() as AccountRow | null) ?? null
    );
  }

  clearAccounts(): void {
    this.db.exec(
      "UPDATE account_state SET active_account_id = NULL WHERE id = 1;",
    );
    this.db.exec("DELETE FROM account;");
  }

  // ---- Projects -----------------------------------------------------------

  upsertProject(input: {
    id: string;
    worktree: string;
    vcs?: string | null;
    branch?: string | null;
    name: string;
  }): ProjectRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO project (id, worktree, vcs, branch, name, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worktree) DO UPDATE SET
           vcs = COALESCE(excluded.vcs, project.vcs),
           branch = COALESCE(excluded.branch, project.branch),
           name = excluded.name,
           time_updated = excluded.time_updated`,
      )
      .run(
        input.id,
        input.worktree,
        input.vcs ?? "git",
        input.branch ?? "main",
        input.name,
        now,
        now,
      );
    return this.db
      .query("SELECT * FROM project WHERE worktree = ?")
      .get(input.worktree) as ProjectRow;
  }

  listProjects(): ProjectRow[] {
    return this.db
      .query("SELECT * FROM project ORDER BY time_updated DESC")
      .all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | null {
    return (
      (this.db
        .query("SELECT * FROM project WHERE id = ?")
        .get(id) as ProjectRow | null) ?? null
    );
  }

  // ---- Sessions -----------------------------------------------------------

  createSession(input: {
    id: string;
    project_id: string;
    slug?: string;
    directory: string;
    title: string;
    agent?: "build" | "plan" | "explore" | "general";
    model_id?: string | null;
  }): SessionRow {
    const now = Date.now();
    const slug = input.slug ?? input.id.slice(0, 8);
    this.db
      .query(
        `INSERT INTO session_v2 (
          id, project_id, slug, directory, title, agent, model_id,
          version, time_created, time_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '1.0.0', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          agent = excluded.agent,
          model_id = COALESCE(excluded.model_id, session_v2.model_id),
          time_updated = excluded.time_updated`,
      )
      .run(
        input.id,
        input.project_id,
        slug,
        input.directory,
        input.title,
        input.agent ?? "build",
        input.model_id ?? null,
        now,
        now,
      );
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRow | null {
    return (
      (this.db
        .query("SELECT * FROM session_v2 WHERE id = ?")
        .get(id) as SessionRow | null) ?? null
    );
  }

  listSessions(projectId?: string): SessionRow[] {
    if (projectId) {
      return this.db
        .query(
          "SELECT * FROM session_v2 WHERE project_id = ? AND time_archived IS NULL ORDER BY time_updated DESC",
        )
        .all(projectId) as SessionRow[];
    }
    return this.db
      .query(
        "SELECT * FROM session_v2 WHERE time_archived IS NULL ORDER BY time_updated DESC",
      )
      .all() as SessionRow[];
  }

  updateSession(
    id: string,
    patch: Partial<{
      title: string;
      agent: "build" | "plan" | "explore" | "general";
      model_id: string | null;
      summary_additions: number;
      summary_deletions: number;
      summary_files: number;
      verified: number;
      verification_summary: string | null;
    }>,
  ): SessionRow | null {
    const current = this.getSession(id);
    if (!current) return null;
    const now = Date.now();
    this.db
      .query(
        `UPDATE session_v2 SET
          title = ?,
          agent = ?,
          model_id = ?,
          summary_additions = ?,
          summary_deletions = ?,
          summary_files = ?,
          verified = ?,
          verification_summary = ?,
          time_updated = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.agent ?? current.agent,
        patch.model_id !== undefined ? patch.model_id : current.model_id,
        patch.summary_additions ?? current.summary_additions,
        patch.summary_deletions ?? current.summary_deletions,
        patch.summary_files ?? current.summary_files,
        patch.verified ?? current.verified,
        patch.verification_summary !== undefined
          ? patch.verification_summary
          : current.verification_summary,
        now,
        id,
      );
    return this.getSession(id);
  }

  // ---- Messages & Parts ---------------------------------------------------

  insertMessage(input: {
    id: string;
    session_id: string;
    role: "user" | "assistant" | "system" | "tool";
    agent?: string;
    model_id?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    data: unknown;
  }): MessageRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO session_message (
          id, session_id, role, agent, model_id,
          input_tokens, output_tokens, cached_tokens,
          time_created, time_updated, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cached_tokens = excluded.cached_tokens,
          time_updated = excluded.time_updated,
          data = excluded.data`,
      )
      .run(
        input.id,
        input.session_id,
        input.role,
        input.agent ?? "build",
        input.model_id ?? null,
        input.input_tokens ?? 0,
        input.output_tokens ?? 0,
        input.cached_tokens ?? 0,
        now,
        now,
        JSON.stringify(input.data),
      );
    this.db
      .query("UPDATE session_v2 SET time_updated = ? WHERE id = ?")
      .run(now, input.session_id);
    return this.db
      .query("SELECT * FROM session_message WHERE id = ?")
      .get(input.id) as MessageRow;
  }

  insertPart(input: {
    id: string;
    message_id: string;
    session_id: string;
    part_type: string;
    data: unknown;
  }): PartRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO session_part (
          id, message_id, session_id, part_type, time_created, time_updated, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          part_type = excluded.part_type,
          time_updated = excluded.time_updated,
          data = excluded.data`,
      )
      .run(
        input.id,
        input.message_id,
        input.session_id,
        input.part_type,
        now,
        now,
        JSON.stringify(input.data),
      );
    return this.db
      .query("SELECT * FROM session_part WHERE id = ?")
      .get(input.id) as PartRow;
  }

  listMessages(sessionId: string): Array<MessageRow & { parts: PartRow[] }> {
    const messages = this.db
      .query(
        "SELECT * FROM session_message WHERE session_id = ? ORDER BY time_created ASC",
      )
      .all(sessionId) as MessageRow[];
    const parts = this.db
      .query(
        "SELECT * FROM session_part WHERE session_id = ? ORDER BY time_created ASC",
      )
      .all(sessionId) as PartRow[];
    const partsByMsg = new Map<string, PartRow[]>();
    for (const part of parts) {
      const list = partsByMsg.get(part.message_id) ?? [];
      list.push(part);
      partsByMsg.set(part.message_id, list);
    }
    return messages.map((m) => ({
      ...m,
      parts: partsByMsg.get(m.id) ?? [],
    }));
  }

  // ---- Artifacts (Right Workspace Column) ---------------------------------

  upsertArtifact(input: {
    id: string;
    session_id: string;
    title: string;
    kind: "architecture" | "plan" | "diff" | "markdown" | "verification";
    file_path?: string | null;
    content: string;
  }): ArtifactRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO artifact (
          id, session_id, title, kind, file_path, content, time_created, time_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          kind = excluded.kind,
          file_path = excluded.file_path,
          content = excluded.content,
          time_updated = excluded.time_updated`,
      )
      .run(
        input.id,
        input.session_id,
        input.title,
        input.kind,
        input.file_path ?? null,
        input.content,
        now,
        now,
      );
    return this.db
      .query("SELECT * FROM artifact WHERE id = ?")
      .get(input.id) as ArtifactRow;
  }

  listArtifacts(sessionId: string): ArtifactRow[] {
    return this.db
      .query(
        "SELECT * FROM artifact WHERE session_id = ? ORDER BY time_updated DESC",
      )
      .all(sessionId) as ArtifactRow[];
  }

  // ---- Schedules (Automations) --------------------------------------------

  upsertSchedule(input: {
    id: string;
    project_id: string;
    name: string;
    cron: string;
    prompt: string;
    agent?: "build" | "plan";
    enabled?: boolean;
  }): ScheduleRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO schedule (
          id, project_id, name, cron, prompt, agent, enabled, time_created, time_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          cron = excluded.cron,
          prompt = excluded.prompt,
          agent = excluded.agent,
          enabled = excluded.enabled,
          time_updated = excluded.time_updated`,
      )
      .run(
        input.id,
        input.project_id,
        input.name,
        input.cron,
        input.prompt,
        input.agent ?? "build",
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.db
      .query("SELECT * FROM schedule WHERE id = ?")
      .get(input.id) as ScheduleRow;
  }

  listSchedules(projectId?: string): ScheduleRow[] {
    if (projectId) {
      return this.db
        .query(
          "SELECT * FROM schedule WHERE project_id = ? ORDER BY time_updated DESC",
        )
        .all(projectId) as ScheduleRow[];
    }
    return this.db
      .query("SELECT * FROM schedule ORDER BY time_updated DESC")
      .all() as ScheduleRow[];
  }

  close(): void {
    this.db.close();
  }
}
