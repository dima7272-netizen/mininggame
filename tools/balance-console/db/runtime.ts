import { getRawDb } from './index';

let initialized: Promise<void> | null = null;

const statements = [
  `CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, default_timezone TEXT NOT NULL, registration_open INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS game_settings (game_id TEXT PRIMARY KEY REFERENCES games(id), owner_timezone TEXT NOT NULL, backup_hour TEXT NOT NULL, backup_timezone TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS game_members (game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, permissions_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (game_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), base_version_id TEXT, base_sha TEXT NOT NULL, content_hash TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, version_name TEXT NOT NULL DEFAULT 'Обновление', notes TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL, change_summary_json TEXT NOT NULL DEFAULT '[]', rollback_target_version_id TEXT, configs_json TEXT NOT NULL, validation_json TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), version_id TEXT NOT NULL REFERENCES versions(id), environment TEXT NOT NULL, status TEXT NOT NULL, operation_id TEXT NOT NULL, checksum TEXT NOT NULL, detail TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS environment_snapshots (game_id TEXT NOT NULL REFERENCES games(id), environment TEXT NOT NULL, version_id TEXT, sha TEXT, configs_json TEXT NOT NULL, checksum TEXT NOT NULL, verified INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (game_id, environment))`,
  `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, permissions_json TEXT NOT NULL, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, entity_id TEXT, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS balance_goals (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), label TEXT NOT NULL, metric TEXT NOT NULL, target_value TEXT NOT NULL, unit TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  'DROP INDEX IF EXISTS idx_versions_game_hash',
  'CREATE INDEX IF NOT EXISTS idx_versions_game_hash ON versions(game_id, content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_versions_game_created ON versions(game_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_versions_game_status ON versions(game_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_deployments_game_started ON deployments(game_id, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_audit_game_created ON audit_logs(game_id, created_at)',
];

export function initializeDb(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const d1 = getRawDb();
    await d1.batch(statements.map((statement) => d1.prepare(statement)));
    const versionColumns = await d1.prepare('PRAGMA table_info(versions)').all<{ name: string }>();
    const names = new Set(versionColumns.results.map((column) => column.name));
    const versionMigrations = [
      ['version_name', "ALTER TABLE versions ADD COLUMN version_name TEXT NOT NULL DEFAULT 'Обновление'"],
      ['notes', "ALTER TABLE versions ADD COLUMN notes TEXT NOT NULL DEFAULT ''"],
      ['change_summary_json', "ALTER TABLE versions ADD COLUMN change_summary_json TEXT NOT NULL DEFAULT '[]'"],
      ['rollback_target_version_id', 'ALTER TABLE versions ADD COLUMN rollback_target_version_id TEXT'],
    ].filter(([column]) => !names.has(column));
    if (versionMigrations.length > 0) {
      await d1.batch(versionMigrations.map(([, statement]) => d1.prepare(statement)));
    }
    await d1.prepare(`UPDATE versions
      SET version_name = CASE
        WHEN source = 'github_import' THEN 'Стартовый импорт'
        WHEN source = 'rollback' THEN 'Откат версии'
        ELSE comment
      END,
      notes = comment
      WHERE version_name = 'Обновление' AND notes = ''`).run();
    await d1.prepare('PRAGMA optimize').run();
  })();
  return initialized;
}
