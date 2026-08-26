import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  defaultTimezone: text('default_timezone').notNull(),
  registrationOpen: integer('registration_open', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('idx_games_slug').on(table.slug)]);

export const gameSettings = sqliteTable('game_settings', {
  gameId: text('game_id').primaryKey().references(() => games.id),
  ownerTimezone: text('owner_timezone').notNull(),
  backupHour: text('backup_hour').notNull(),
  backupTimezone: text('backup_timezone').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('idx_users_email').on(table.email)]);

export const authCredentials = sqliteTable('auth_credentials', {
  userId: text('user_id').primaryKey().references(() => users.id),
  passwordSalt: text('password_salt').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordIterations: integer('password_iterations').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, (table) => [
  index('idx_auth_sessions_user').on(table.userId),
  index('idx_auth_sessions_expires').on(table.expiresAt),
]);

export const authIdentities = sqliteTable('auth_identities', {
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  providerEmail: text('provider_email').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.provider, table.providerUserId] }),
  uniqueIndex('idx_auth_identities_provider_user').on(table.provider, table.userId),
  index('idx_auth_identities_user').on(table.userId),
]);

export const gameMembers = sqliteTable('game_members', {
  gameId: text('game_id').notNull().references(() => games.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),
  permissionsJson: text('permissions_json').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.gameId, table.userId] }),
  index('idx_game_members_user').on(table.userId),
]);

export const versions = sqliteTable('versions', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  baseVersionId: text('base_version_id'),
  baseSha: text('base_sha').notNull(),
  contentHash: text('content_hash').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: integer('created_at').notNull(),
  name: text('version_name').notNull().default('Обновление'),
  notes: text('notes').notNull().default(''),
  comment: text('comment').notNull(),
  changeSummaryJson: text('change_summary_json').notNull().default('[]'),
  rollbackTargetVersionId: text('rollback_target_version_id'),
  configsJson: text('configs_json').notNull(),
  validationJson: text('validation_json').notNull(),
  status: text('status').notNull(),
  source: text('source').notNull(),
}, (table) => [
  index('idx_versions_game_created').on(table.gameId, table.createdAt),
  index('idx_versions_game_status').on(table.gameId, table.status),
  index('idx_versions_game_hash').on(table.gameId, table.contentHash),
]);

export const deployments = sqliteTable('deployments', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  versionId: text('version_id').notNull().references(() => versions.id),
  environment: text('environment').notNull(),
  status: text('status').notNull(),
  operationId: text('operation_id').notNull(),
  checksum: text('checksum').notNull(),
  detail: text('detail').notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
}, (table) => [index('idx_deployments_game_started').on(table.gameId, table.startedAt)]);

export const environmentSnapshots = sqliteTable('environment_snapshots', {
  gameId: text('game_id').notNull().references(() => games.id),
  environment: text('environment').notNull(),
  versionId: text('version_id'),
  sha: text('sha'),
  configsJson: text('configs_json').notNull(),
  checksum: text('checksum').notNull(),
  verified: integer('verified', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.gameId, table.environment] })]);

export const invitations = sqliteTable('invitations', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  tokenHash: text('token_hash').notNull(),
  role: text('role').notNull(),
  permissionsJson: text('permissions_json').notNull(),
  expiresAt: integer('expires_at').notNull(),
  maxUses: integer('max_uses').notNull(),
  uses: integer('uses').notNull().default(0),
  revokedAt: integer('revoked_at'),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('idx_invitations_token').on(table.tokenHash)]);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  userId: text('user_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  entityId: text('entity_id'),
  detailJson: text('detail_json').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('idx_audit_game_created').on(table.gameId, table.createdAt)]);

export const balanceGoals = sqliteTable('balance_goals', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  label: text('label').notNull(),
  metric: text('metric').notNull(),
  targetValue: text('target_value').notNull(),
  unit: text('unit').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('idx_goals_game').on(table.gameId)]);
