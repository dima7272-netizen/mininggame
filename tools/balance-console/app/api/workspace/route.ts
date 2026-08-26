import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/current-user';
import { assertSameOrigin } from '@/lib/app-auth';
import {
  createInvitation,
  createVersion,
  getVersion,
  getWorkspace,
  recordPublish,
  removeGameMember,
  revokeInvitation,
  saveBalanceGoal,
  setVersionStatus,
  updateGameSettings,
  updateGameMember,
} from '@/db/repository';
import { assertPermission, permissions, type Permission, type Role } from '@/lib/rbac';
import {
  assertProdEligibility,
  GitHubPublisher,
  getPublishingInfo,
  hashConfigBundle,
  isRealDeployment,
  nextStatus,
} from '@/lib/publishing';
import { validateConfigs } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const configMapSchema = z.record(z.string().min(1), z.string().max(4_000_000));
const memberRoleSchema = z.enum(['admin', 'balancer', 'tester', 'prod_publisher', 'observer']);
const permissionSchema = z.enum(permissions);

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('validate'), configs: configMapSchema }),
  z.object({
    action: z.literal('save'),
    configs: configMapSchema,
    baseVersionId: z.string().nullable(),
    baseSha: z.string().min(1),
    name: z.string().trim().min(3).max(120),
    notes: z.string().trim().min(3).max(2_000),
  }),
  z.object({
    action: z.literal('mark_ready'),
    versionId: z.string().min(1),
    warningsAcknowledged: z.boolean(),
  }),
  z.object({ action: z.literal('publish_dev'), versionId: z.string().min(1) }),
  z.object({ action: z.literal('approve_testing'), versionId: z.string().min(1) }),
  z.object({ action: z.literal('publish_prod'), versionId: z.string().min(1), confirmation: z.literal('DIG GET STRONGER / PROD') }),
  z.object({ action: z.literal('rollback'), versionId: z.string().min(1), reason: z.string().trim().min(3).max(2_000) }),
  z.object({ action: z.literal('revoke_invitation'), invitationId: z.string().uuid() }),
  z.object({
    action: z.literal('update_member'),
    userId: z.string().min(1).max(200),
    role: memberRoleSchema,
    extraPermissions: z.array(permissionSchema).max(permissions.length),
  }),
  z.object({ action: z.literal('remove_member'), userId: z.string().min(1).max(200) }),
  z.object({
    action: z.literal('save_goal'),
    label: z.string().trim().min(3).max(120),
    metric: z.string().trim().min(2).max(80),
    targetValue: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/),
    unit: z.string().trim().min(1).max(40),
  }),
  z.object({
    action: z.literal('update_settings'),
    ownerTimezone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_+-]+$/),
    backupHour: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    backupTimezone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_+-]+$/),
  }),
  z.object({
    action: z.literal('invite'),
    role: memberRoleSchema,
    extraPermissions: z.array(permissionSchema).max(permissions.length),
    expiresInHours: z.number().int().min(1).max(24 * 30),
    maxUses: z.number().int().min(1).max(100),
  }),
]);

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getWorkspace(user), noStore());
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await getCurrentUser();
    const workspace = await getWorkspace(user);
    const input = actionSchema.parse(await request.json());
    const role = workspace.access.role as Role;
    const extra = workspace.access.extraPermissions as Permission[];

    if (input.action === 'validate') {
      assertPermission(role, 'configs:view', extra);
      return NextResponse.json({ validation: validateConfigs(input.configs) }, noStore());
    }

    if (input.action === 'save') {
      assertPermission(role, 'configs:edit', extra);
      const current = workspace.versions[0];
      if (current && input.baseVersionId !== current.id) {
        throw new Error('Базовая версия устарела. Сравните изменения с актуальной версией перед сохранением.');
      }
      if (current && input.baseSha !== current.baseSha) {
        throw new Error('Git SHA изменился после создания черновика. Нужен повторный импорт или перенос правок.');
      }
      const version = await createVersion({
        userId: user.userId,
        configs: input.configs,
        baseVersionId: input.baseVersionId,
        baseSha: input.baseSha,
        name: input.name,
        notes: input.notes,
      });
      return NextResponse.json({ version, workspace: await getWorkspace(user) }, noStore());
    }

    if (input.action === 'mark_ready') {
      assertPermission(role, 'configs:edit', extra);
      const version = await getVersion(input.versionId);
      if (!version.validation.canPublish) throw new Error('Исправьте блокирующие ошибки перед подготовкой DEV.');
      if (version.validation.warningCount > 0 && !input.warningsAcknowledged) {
        throw new Error('Нужно явно подтвердить просмотр предупреждений.');
      }
      await setVersionStatus(user.userId, version.id, nextStatus(version.status, 'mark_ready'));
    }

    if (input.action === 'publish_dev') {
      assertPermission(role, 'publish:dev', extra);
      if (workspace.versions[0]?.id !== input.versionId) {
        throw new Error('Публиковать можно только последнюю сохранённую версию.');
      }
      let version = await getVersion(input.versionId);
      const alreadyReal = workspace.deployments.some((item) =>
        item.versionId === version.id && item.environment === 'DEV' && item.status === 'verified'
        && isRealDeployment(item.operationId, 'DEV'),
      );
      if (alreadyReal) throw new Error('Эта версия уже подтверждённо опубликована в настоящий DEV.');
      if (!['ready_dev', 'published_dev', 'tested'].includes(version.status)) {
        throw new Error('Сначала подготовьте последнюю версию к DEV.');
      }

      const publisher = new GitHubPublisher();
      const prepared = await publisher.prepareRebase(version.baseSha, version.configs);
      const mergedHash = await hashConfigBundle(prepared.configs);
      if (prepared.headSha !== version.baseSha || mergedHash !== version.contentHash) {
        const mergedValidation = validateConfigs(prepared.configs);
        if (!mergedValidation.canPublish) {
          throw new Error('После объединения с GitHub появились блокирующие ошибки. Исправьте их перед публикацией.');
        }
        const preserved = prepared.remoteChanged.filter((name) => !prepared.userChanged.includes(name));
        version = await createVersion({
          userId: user.userId,
          configs: prepared.configs,
          baseVersionId: version.id,
          baseSha: prepared.headSha,
          name: `${version.name} · синхронизация DEV`,
          notes: [
            version.notes,
            `Перед настоящей публикацией объединено с GitHub main (${prepared.headSha.slice(0, 7)}).`,
            preserved.length > 0 ? `Сохранены более новые изменения GitHub: ${preserved.join(', ')}.` : '',
          ].filter(Boolean).join('\n\n'),
          source: 'github_rebase',
        });
        await setVersionStatus(user.userId, version.id, 'ready_dev');
      }
      const receipt = await publisher.publish('DEV', version.id, version.configs, prepared.headSha);
      await recordPublish(user.userId, version.id, receipt);
      await setVersionStatus(user.userId, version.id, 'published_dev');
    }

    if (input.action === 'approve_testing') {
      assertPermission(role, 'testing:approve', extra);
      const version = await getVersion(input.versionId);
      const realDevDeployment = workspace.deployments.find((item) =>
        item.versionId === version.id && item.environment === 'DEV' && item.status === 'verified'
        && isRealDeployment(item.operationId, 'DEV'),
      );
      if (!realDevDeployment) {
        throw new Error('Сначала опубликуйте эту версию в настоящий DEV и дождитесь проверки GitHub Actions.');
      }
      await setVersionStatus(user.userId, version.id, nextStatus(version.status, 'approve_testing'));
    }

    if (input.action === 'publish_prod') {
      assertPermission(role, 'publish:prod', extra);
      const version = await getVersion(input.versionId);
      const devDeployment = workspace.deployments.find((item) =>
        item.versionId === version.id && item.environment === 'DEV' && item.status === 'verified'
        && isRealDeployment(item.operationId, 'DEV'),
      );
      assertProdEligibility({
        versionId: version.id,
        devVersionId: devDeployment?.versionId ?? null,
        testedVersionId: version.status === 'tested' ? version.id : null,
        status: version.status,
      });
      if (!getPublishingInfo().prodReady) {
        throw new Error('Настоящая публикация PROD отключена отдельно. DEV при этом работает.');
      }
      const receipt = await new GitHubPublisher().publish('PROD', version.id, version.configs);
      await recordPublish(user.userId, version.id, receipt);
      await setVersionStatus(user.userId, version.id, nextStatus(version.status, 'publish_prod'));
    }

    if (input.action === 'rollback') {
      assertPermission(role, 'versions:rollback', extra);
      const target = await getVersion(input.versionId);
      const current = workspace.versions[0];
      await createVersion({
        userId: user.userId,
        configs: target.configs,
        baseVersionId: current?.id ?? null,
        baseSha: current?.baseSha ?? target.baseSha,
        name: `Откат: ${target.name}`,
        notes: `${input.reason}\n\nВосстановлена версия «${target.name}» от ${new Date(target.createdAt).toISOString()} (${target.id}).`,
        source: 'rollback',
        rollbackTargetVersionId: target.id,
      });
    }

    if (input.action === 'revoke_invitation') {
      assertPermission(role, 'users:manage', extra);
      await revokeInvitation(user.userId, input.invitationId);
    }

    if (input.action === 'update_member') {
      assertPermission(role, 'users:manage', extra);
      await updateGameMember({
        actorUserId: user.userId,
        targetUserId: input.userId,
        role: input.role,
        extraPermissions: input.extraPermissions,
      });
    }

    if (input.action === 'remove_member') {
      assertPermission(role, 'users:manage', extra);
      await removeGameMember({ actorUserId: user.userId, targetUserId: input.userId });
    }

    if (input.action === 'save_goal') {
      assertPermission(role, 'configs:edit', extra);
      await saveBalanceGoal({ userId: user.userId, ...input });
    }

    if (input.action === 'update_settings') {
      assertPermission(role, 'connections:manage', extra);
      await updateGameSettings({ userId: user.userId, ...input });
    }

    if (input.action === 'invite') {
      assertPermission(role, 'users:manage', extra);
      const token = randomToken();
      await createInvitation({
        userId: user.userId,
        tokenHash: await sha256(token),
        role: input.role,
        extraPermissions: input.extraPermissions,
        expiresAt: Date.now() + input.expiresInHours * 60 * 60 * 1000,
        maxUses: input.maxUses,
      });
      return NextResponse.json({
        invitation: {
          token,
          path: `/invite/${token}`,
          note: 'Токен показывается только один раз; в базе хранится только SHA-256.',
        },
      }, noStore());
    }

    return NextResponse.json({ workspace: await getWorkspace(user) }, noStore());
  } catch (error) {
    return failure(error);
  }
}

function noStore() {
  return { headers: { 'Cache-Control': 'no-store' } };
}

function failure(error: unknown) {
  const message = error instanceof z.ZodError
    ? error.issues.map((item) => item.message).join('; ')
    : error instanceof Error
      ? error.message
      : 'Неизвестная ошибка';
  return NextResponse.json({ error: message }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
