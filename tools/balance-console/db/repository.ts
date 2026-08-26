import { and, desc, eq } from 'drizzle-orm';
import { getDb } from './index';
import { initializeDb } from './runtime';
import {
  auditLogs,
  deployments,
  environmentSnapshots,
  gameSettings,
  gameMembers,
  games,
  invitations,
  users,
  versions,
  balanceGoals,
} from './schema';
import { seedGitSha } from '@/lib/generated/seed-configs';
import { githubSnapshot, spreadsheetPreviewSnapshot } from '@/lib/source-snapshots';
import { getPublishingInfo, hashConfigBundle, type PublishReceipt, type VersionStatus } from '@/lib/publishing';
import { validateConfigs, type ValidationResult } from '@/lib/validation';
import type { AppUser } from '@/lib/current-user';
import type { ConfigTextMap } from '@/lib/config-model';
import { hasPermission, type Permission, type Role } from '@/lib/rbac';
import { redactSecrets } from '@/lib/security';
import { diffConfigs, type ConfigChange } from '@/lib/config-diff';
import { roundRoomHpToIntegers } from '@/lib/room-hp';
import { arrangeRewardsByGameHierarchy } from '@/lib/reward-hierarchy';
import { buildRewardExpansion } from '@/lib/reward-expansion';
import { rewardHierarchyItemIds } from '@/lib/reward-groups';

export const GAME_ID = 'dig-get-stronger';

export type StoredVersion = {
  id: string;
  gameId: string;
  baseVersionId: string | null;
  baseSha: string;
  contentHash: string;
  createdBy: string;
  createdAt: number;
  name: string;
  notes: string;
  comment: string;
  changeSummary: ConfigChange[];
  rollbackTargetVersionId: string | null;
  configs: ConfigTextMap;
  validation: ValidationResult;
  status: VersionStatus;
  source: string;
};

export async function ensureBootstrap(user: AppUser) {
  await initializeDb();
  const db = getDb();
  const now = Date.now();

  await db.insert(games).values({
    id: GAME_ID,
    slug: GAME_ID,
    name: 'Dig Get Stronger',
    defaultTimezone: 'Europe/Lisbon',
    registrationOpen: false,
    createdAt: now,
  }).onConflictDoNothing();
  await db.insert(gameSettings).values({
    gameId: GAME_ID,
    ownerTimezone: 'Europe/Lisbon',
    backupHour: '02:00',
    backupTimezone: 'Europe/Moscow',
    updatedAt: now,
  }).onConflictDoNothing();
  await db.insert(users).values({
    id: user.userId,
    email: user.email,
    displayName: user.displayName,
    createdAt: now,
  }).onConflictDoUpdate({
    target: users.id,
    set: { email: user.email, displayName: user.displayName },
  });

  // Only the first authenticated account becomes the bootstrap owner. Every
  // later account must present an invitation; open registration stays closed.
  const firstMember = await db.select().from(gameMembers)
    .where(eq(gameMembers.gameId, GAME_ID))
    .limit(1);
  if (firstMember.length === 0) {
    await db.insert(gameMembers).values({
      gameId: GAME_ID,
      userId: user.userId,
      role: 'owner',
      permissionsJson: '[]',
      createdAt: now,
    }).onConflictDoNothing();
  }

  const existing = await db.select().from(versions).where(eq(versions.gameId, GAME_ID)).limit(1);
  if (existing.length === 0) {
    const validation = validateConfigs(githubSnapshot, { comparison: spreadsheetPreviewSnapshot });
    const contentHash = await hashConfigBundle(githubSnapshot);
    const versionId = `v-${contentHash.slice(0, 12)}`;
    await db.insert(versions).values({
      id: versionId,
      gameId: GAME_ID,
      baseVersionId: null,
      baseSha: seedGitSha,
      contentHash,
      createdBy: user.userId,
      createdAt: now,
      name: 'Стартовый импорт',
      notes: 'Исходный снимок конфигурации GitHub main до ручной настройки баланса.',
      comment: 'Стартовый неизменяемый снимок GitHub main',
      changeSummaryJson: '[]',
      rollbackTargetVersionId: null,
      configsJson: JSON.stringify(githubSnapshot),
      validationJson: JSON.stringify(validation),
      status: 'draft',
      source: 'github_import',
    });

    const devHash = contentHash;
    const prodHash = await hashConfigBundle(spreadsheetPreviewSnapshot);
    await db.insert(environmentSnapshots).values([
      {
        gameId: GAME_ID,
        environment: 'DEV',
        versionId,
        sha: seedGitSha,
        configsJson: JSON.stringify(githubSnapshot),
        checksum: devHash,
        verified: false,
        updatedAt: now,
      },
      {
        gameId: GAME_ID,
        environment: 'PROD_OBSERVED',
        versionId: null,
        sha: null,
        configsJson: JSON.stringify(spreadsheetPreviewSnapshot),
        checksum: prodHash,
        verified: false,
        updatedAt: now,
      },
    ]);
    await logAction(user.userId, 'bootstrap.import', versionId, {
      source: 'GitHub + Google Sheets preview',
      externalWrites: false,
    });
  }

  // Older installations already have complete immutable config snapshots. Fill
  // the new human-readable change journal from those snapshots without touching
  // or replacing any historical version.
  const historicalVersions = await db.select({
    id: versions.id,
    baseVersionId: versions.baseVersionId,
    configsJson: versions.configsJson,
    changeSummaryJson: versions.changeSummaryJson,
    source: versions.source,
    comment: versions.comment,
    rollbackTargetVersionId: versions.rollbackTargetVersionId,
  }).from(versions).where(eq(versions.gameId, GAME_ID));
  const historyById = new Map(historicalVersions.map((version) => [version.id, version]));
  for (const version of historicalVersions) {
    const update: { changeSummaryJson?: string; rollbackTargetVersionId?: string } = {};
    const base = version.baseVersionId ? historyById.get(version.baseVersionId) : null;
    if (version.changeSummaryJson === '[]' && base) {
      const summary = diffConfigs(
        JSON.parse(base.configsJson) as ConfigTextMap,
        JSON.parse(version.configsJson) as ConfigTextMap,
      );
      if (summary.length > 0) update.changeSummaryJson = JSON.stringify(summary);
    }
    if (version.source === 'rollback' && !version.rollbackTargetVersionId) {
      const targetId = version.comment.match(/^Откат на ([^:]+):/)?.[1];
      if (targetId && historyById.has(targetId)) update.rollbackTargetVersionId = targetId;
    }
    if (Object.keys(update).length > 0) {
      await db.update(versions).set(update).where(eq(versions.id, version.id));
    }
  }
}

export async function getWorkspace(user: AppUser) {
  await ensureBootstrap(user);
  const db = getDb();
  const [member] = await db.select().from(gameMembers).where(and(
    eq(gameMembers.gameId, GAME_ID),
    eq(gameMembers.userId, user.userId),
  )).limit(1);
  if (!member) throw new Error('Нет доступа к игре. Используйте действующее приглашение.');

  await ensureIntegerRoomHpDraft(user.userId);
  if (member.role === 'owner') {
    await ensureRewardHierarchyDraft(user.userId);
    await ensureRewardExpansionDraft(user.userId);
  }

  const versionRows = await db.select().from(versions)
    .where(eq(versions.gameId, GAME_ID))
    .orderBy(desc(versions.createdAt));
  const deploymentRows = await db.select().from(deployments)
    .where(eq(deployments.gameId, GAME_ID))
    .orderBy(desc(deployments.startedAt))
    .limit(20);
  const snapshots = await db.select().from(environmentSnapshots)
    .where(eq(environmentSnapshots.gameId, GAME_ID));
  const logs = await db.select().from(auditLogs)
    .where(eq(auditLogs.gameId, GAME_ID))
    .orderBy(desc(auditLogs.createdAt))
    .limit(30);
  const [settings] = await db.select().from(gameSettings)
    .where(eq(gameSettings.gameId, GAME_ID)).limit(1);
  const goals = await db.select().from(balanceGoals)
    .where(eq(balanceGoals.gameId, GAME_ID)).orderBy(desc(balanceGoals.createdAt));
  const extraPermissions = JSON.parse(member.permissionsJson) as Permission[];
  const memberRows = await db.select({
    userId: gameMembers.userId,
    role: gameMembers.role,
    permissionsJson: gameMembers.permissionsJson,
    joinedAt: gameMembers.createdAt,
    email: users.email,
    displayName: users.displayName,
  }).from(gameMembers).innerJoin(users, eq(gameMembers.userId, users.id))
    .where(eq(gameMembers.gameId, GAME_ID))
    .orderBy(gameMembers.createdAt);
  const invitationRows = hasPermission(member.role as Role, 'users:manage', extraPermissions)
    ? await db.select({
      id: invitations.id,
      role: invitations.role,
      permissionsJson: invitations.permissionsJson,
      expiresAt: invitations.expiresAt,
      maxUses: invitations.maxUses,
      uses: invitations.uses,
      revokedAt: invitations.revokedAt,
      createdBy: invitations.createdBy,
      createdAt: invitations.createdAt,
    }).from(invitations).where(eq(invitations.gameId, GAME_ID)).orderBy(desc(invitations.createdAt))
    : [];

  return {
    game: { id: GAME_ID, name: 'Dig Get Stronger', timezone: settings?.ownerTimezone ?? 'Europe/Lisbon' },
    publishing: getPublishingInfo(),
    settings,
    goals,
    members: memberRows.map((row) => ({
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as Role,
      extraPermissions: JSON.parse(row.permissionsJson) as Permission[],
      joinedAt: row.joinedAt,
    })),
    invitations: invitationRows.map((row) => ({
      ...row,
      extraPermissions: JSON.parse(row.permissionsJson) as Permission[],
    })),
    user,
    access: {
      role: member.role as Role,
      extraPermissions,
    },
    versions: versionRows.map(mapVersion),
    deployments: deploymentRows,
    snapshots: snapshots.map((snapshot) => ({
      ...snapshot,
      configs: JSON.parse(snapshot.configsJson) as ConfigTextMap,
    })),
    logs: logs.map((log) => ({ ...log, detail: JSON.parse(log.detailJson) })),
  };
}

async function ensureIntegerRoomHpDraft(userId: string) {
  const db = getDb();
  const [latest] = await db.select().from(versions)
    .where(eq(versions.gameId, GAME_ID))
    .orderBy(desc(versions.createdAt))
    .limit(1);
  if (!latest) return;

  const configs = JSON.parse(latest.configsJson) as ConfigTextMap;
  const normalized = roundRoomHpToIntegers(configs);
  if (normalized === configs) return;

  await createVersion({
    userId,
    configs: normalized,
    baseVersionId: latest.id,
    baseSha: latest.baseSha,
    name: 'Целые значения HP стен',
    notes: 'Сохранён прежний плавный рост мощности стен. Дробные и степенные значения HP округлены и записаны полными целыми числами для совместимости с игрой.',
    source: 'integer_room_hp_fix',
  });
}

async function ensureRewardHierarchyDraft(userId: string) {
  const db = getDb();
  const [latest] = await db.select().from(versions)
    .where(eq(versions.gameId, GAME_ID))
    .orderBy(desc(versions.createdAt))
    .limit(1);
  if (!latest) return;

  const configs = JSON.parse(latest.configsJson) as ConfigTextMap;
  const arranged = arrangeRewardsByGameHierarchy(configs);
  if (arranged === configs) return;

  await createVersion({
    userId,
    configs: arranged,
    baseVersionId: latest.id,
    baseSha: latest.baseSha,
    name: 'Награды по иерархии редкостей',
    notes: 'Все 75 наград выстроены блоками по иерархии Roblox: Обычные → Необычные → Редкие → Эпические → Легендарные → Мифические → Секретные → Богоподобные → Божественные → Небесные. Существующая лестница круглых цен сохранена и переназначена по этому порядку. Изменение сохранено черновиком и не опубликовано в DEV.',
    source: 'reward_hierarchy_fix',
  });
}

async function ensureRewardExpansionDraft(userId: string) {
  const db = getDb();
  const [latest] = await db.select().from(versions)
    .where(eq(versions.gameId, GAME_ID))
    .orderBy(desc(versions.createdAt))
    .limit(1);
  if (!latest) return;

  const configs = JSON.parse(latest.configsJson) as ConfigTextMap;
  const { configs: expanded, report } = buildRewardExpansion(configs);
  if (expanded === configs) return;

  await createVersion({
    userId,
    configs: expanded,
    baseVersionId: latest.id,
    baseSha: latest.baseSha,
    name: 'Награды без богоподобных · 50 комнат',
    notes: `Все ${report.retiredItemIds.length} богоподобных предметов исключены из SellItems и комнат — их модели сохранены для будущих золотых питомцев. ${rewardHierarchyItemIds.length} остальных наград перераспределены до комнаты 50, цены выстроены возрастающими круглыми числами, а проценты выпадения оставлены целыми. Для комнат 1–${report.existingRoomCount} средняя награда сохранена с максимальным отклонением ${report.maximumExistingRewardDeviationPercent.toFixed(2)}%. Комнаты 47–50 продолжают текущий рост награды и HP. Черновик не опубликован в DEV.`,
    source: 'remove_godly_extend_50',
  });
}

export async function getVersion(versionId: string): Promise<StoredVersion> {
  await initializeDb();
  const [row] = await getDb().select().from(versions).where(and(
    eq(versions.gameId, GAME_ID),
    eq(versions.id, versionId),
  )).limit(1);
  if (!row) throw new Error('Версия не найдена.');
  return mapVersion(row);
}

export async function createVersion(input: {
  userId: string;
  configs: ConfigTextMap;
  baseVersionId: string | null;
  baseSha: string;
  name: string;
  notes: string;
  source?: string;
  rollbackTargetVersionId?: string | null;
}): Promise<StoredVersion> {
  await initializeDb();
  const db = getDb();
  const validation = validateConfigs(input.configs, { comparison: spreadsheetPreviewSnapshot });
  const contentHash = await hashConfigBundle(input.configs);
  const id = `v-${Date.now().toString(36)}-${contentHash.slice(0, 8)}`;
  let changeSummary: ConfigChange[] = [];
  if (input.baseVersionId) {
    const [base] = await db.select({ configsJson: versions.configsJson }).from(versions).where(and(
      eq(versions.gameId, GAME_ID),
      eq(versions.id, input.baseVersionId),
    )).limit(1);
    if (base) changeSummary = diffConfigs(JSON.parse(base.configsJson) as ConfigTextMap, input.configs);
  }
  const row = {
    id,
    gameId: GAME_ID,
    baseVersionId: input.baseVersionId,
    baseSha: input.baseSha,
    contentHash,
    createdBy: input.userId,
    createdAt: Date.now(),
    name: input.name,
    notes: input.notes,
    comment: input.notes || input.name,
    changeSummaryJson: JSON.stringify(changeSummary),
    rollbackTargetVersionId: input.rollbackTargetVersionId ?? null,
    configsJson: JSON.stringify(input.configs),
    validationJson: JSON.stringify(validation),
    status: 'draft' as const,
    source: input.source ?? 'balance_console',
  };
  await db.insert(versions).values(row);
  await logAction(input.userId, 'version.create', id, {
    name: input.name,
    notes: input.notes,
    changedFields: changeSummary.length,
    rollbackTargetVersionId: input.rollbackTargetVersionId ?? null,
    contentHash,
  });
  return mapVersion(row);
}

export async function setVersionStatus(userId: string, versionId: string, status: VersionStatus) {
  await initializeDb();
  await getDb().update(versions).set({ status }).where(and(
    eq(versions.gameId, GAME_ID),
    eq(versions.id, versionId),
  ));
  await logAction(userId, `version.${status}`, versionId, {});
}

export async function recordPublish(userId: string, versionId: string, receipt: PublishReceipt) {
  await initializeDb();
  const db = getDb();
  const now = Date.now();
  await db.insert(deployments).values({
    id: crypto.randomUUID(),
    gameId: GAME_ID,
    versionId,
    environment: receipt.environment,
    status: receipt.verified ? 'verified' : 'failed',
    operationId: receipt.operationId,
    checksum: receipt.checksum,
    detail: receipt.detail,
    startedAt: now,
    completedAt: now,
  });
  const version = await getVersion(versionId);
  await db.insert(environmentSnapshots).values({
    gameId: GAME_ID,
    environment: receipt.environment,
    versionId,
    sha: version.baseSha,
    configsJson: JSON.stringify(version.configs),
    checksum: receipt.checksum,
    verified: receipt.verified,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [environmentSnapshots.gameId, environmentSnapshots.environment],
    set: {
      versionId,
      sha: version.baseSha,
      configsJson: JSON.stringify(version.configs),
      checksum: receipt.checksum,
      verified: receipt.verified,
      updatedAt: now,
    },
  });
  await logAction(userId, `publish.${receipt.environment.toLowerCase()}`, versionId, receipt);
}

export async function createInvitation(input: {
  userId: string;
  tokenHash: string;
  role: Role;
  extraPermissions: Permission[];
  expiresAt: number;
  maxUses: number;
}) {
  await initializeDb();
  const id = crypto.randomUUID();
  await getDb().insert(invitations).values({
    id,
    gameId: GAME_ID,
    tokenHash: input.tokenHash,
    role: input.role,
    permissionsJson: JSON.stringify(input.extraPermissions),
    expiresAt: input.expiresAt,
    maxUses: input.maxUses,
    uses: 0,
    revokedAt: null,
    createdBy: input.userId,
    createdAt: Date.now(),
  });
  await logAction(input.userId, 'invitation.create', id, {
    role: input.role,
    expiresAt: input.expiresAt,
    maxUses: input.maxUses,
  });
  return id;
}

export async function revokeInvitation(userId: string, invitationId: string) {
  await initializeDb();
  await getDb().update(invitations).set({ revokedAt: Date.now() }).where(and(
    eq(invitations.gameId, GAME_ID),
    eq(invitations.id, invitationId),
  ));
  await logAction(userId, 'invitation.revoke', invitationId, {});
}

export async function updateGameMember(input: {
  actorUserId: string;
  targetUserId: string;
  role: Exclude<Role, 'owner'>;
  extraPermissions: Permission[];
}) {
  await initializeDb();
  const db = getDb();
  const [target] = await db.select().from(gameMembers).where(and(
    eq(gameMembers.gameId, GAME_ID),
    eq(gameMembers.userId, input.targetUserId),
  )).limit(1);
  if (!target) throw new Error('Участник команды не найден.');
  if (target.userId === input.actorUserId) throw new Error('Нельзя изменить собственную роль.');
  if (target.role === 'owner') throw new Error('Роль владельца защищена и не редактируется.');

  const extraPermissions = [...new Set(input.extraPermissions)];
  await db.update(gameMembers).set({
    role: input.role,
    permissionsJson: JSON.stringify(extraPermissions),
  }).where(and(
    eq(gameMembers.gameId, GAME_ID),
    eq(gameMembers.userId, input.targetUserId),
  ));
  await logAction(input.actorUserId, 'member.update', input.targetUserId, {
    role: input.role,
    extraPermissions,
  });
}

export async function removeGameMember(input: { actorUserId: string; targetUserId: string }) {
  await initializeDb();
  const db = getDb();
  const [target] = await db.select().from(gameMembers).where(and(
    eq(gameMembers.gameId, GAME_ID),
    eq(gameMembers.userId, input.targetUserId),
  )).limit(1);
  if (!target) throw new Error('Участник команды не найден.');
  if (target.userId === input.actorUserId) throw new Error('Нельзя исключить самого себя.');
  if (target.role === 'owner') throw new Error('Владельца нельзя исключить из команды.');

  await db.delete(gameMembers).where(and(
    eq(gameMembers.gameId, GAME_ID),
    eq(gameMembers.userId, input.targetUserId),
  ));
  await logAction(input.actorUserId, 'member.remove', input.targetUserId, { previousRole: target.role });
}

export async function saveBalanceGoal(input: {
  userId: string;
  label: string;
  metric: string;
  targetValue: string;
  unit: string;
}) {
  await initializeDb();
  const id = crypto.randomUUID();
  await getDb().insert(balanceGoals).values({
    id,
    gameId: GAME_ID,
    label: input.label,
    metric: input.metric,
    targetValue: input.targetValue,
    unit: input.unit,
    createdAt: Date.now(),
  });
  await logAction(input.userId, 'goal.create', id, {
    label: input.label,
    metric: input.metric,
    targetValue: input.targetValue,
    unit: input.unit,
  });
  return id;
}

export async function updateGameSettings(input: {
  userId: string;
  ownerTimezone: string;
  backupHour: string;
  backupTimezone: string;
}) {
  await initializeDb();
  await getDb().update(gameSettings).set({
    ownerTimezone: input.ownerTimezone,
    backupHour: input.backupHour,
    backupTimezone: input.backupTimezone,
    updatedAt: Date.now(),
  }).where(eq(gameSettings.gameId, GAME_ID));
  await logAction(input.userId, 'settings.update', GAME_ID, input);
}

export async function acceptInvitation(input: { user: AppUser; token: string }) {
  await ensureBootstrap(input.user);
  const db = getDb();
  const tokenHash = await sha256(input.token);
  const [invitation] = await db.select().from(invitations).where(and(
    eq(invitations.gameId, GAME_ID),
    eq(invitations.tokenHash, tokenHash),
  )).limit(1);

  if (!invitation || invitation.revokedAt !== null) {
    throw new Error('Приглашение не найдено или отозвано.');
  }
  if (invitation.expiresAt <= Date.now()) throw new Error('Срок действия приглашения истёк.');
  if (invitation.uses >= invitation.maxUses) throw new Error('Лимит использований приглашения исчерпан.');

  const [existing] = await db.select().from(gameMembers).where(and(
    eq(gameMembers.gameId, GAME_ID),
    eq(gameMembers.userId, input.user.userId),
  )).limit(1);
  if (existing) return { role: existing.role as Role, alreadyMember: true };

  await db.insert(gameMembers).values({
    gameId: GAME_ID,
    userId: input.user.userId,
    role: invitation.role,
    permissionsJson: invitation.permissionsJson,
    createdAt: Date.now(),
  });
  await db.update(invitations).set({ uses: invitation.uses + 1 }).where(and(
    eq(invitations.id, invitation.id),
    eq(invitations.uses, invitation.uses),
  ));
  await logAction(input.user.userId, 'invitation.accept', invitation.id, {
    role: invitation.role,
  });
  return { role: invitation.role as Role, alreadyMember: false };
}

export async function logAction(userId: string, action: string, entityId: string | null, detail: unknown) {
  await initializeDb();
  await getDb().insert(auditLogs).values({
    id: crypto.randomUUID(),
    gameId: GAME_ID,
    userId,
    action,
    entityId,
    detailJson: JSON.stringify(redactSecrets(detail)),
    createdAt: Date.now(),
  });
}

function mapVersion(row: typeof versions.$inferSelect): StoredVersion {
  return {
    id: row.id,
    gameId: row.gameId,
    baseVersionId: row.baseVersionId,
    baseSha: row.baseSha,
    contentHash: row.contentHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    name: row.name,
    notes: row.notes,
    comment: row.comment,
    changeSummary: JSON.parse(row.changeSummaryJson) as ConfigChange[],
    rollbackTargetVersionId: row.rollbackTargetVersionId,
    configs: JSON.parse(row.configsJson) as ConfigTextMap,
    validation: JSON.parse(row.validationJson) as ValidationResult,
    status: row.status as VersionStatus,
    source: row.source,
  };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
