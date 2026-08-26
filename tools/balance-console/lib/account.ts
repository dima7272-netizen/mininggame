import { getRawDb } from '@/db';
import { GAME_ID } from '@/db/repository';
import { initializeDb } from '@/db/runtime';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import type { AuthUser } from './app-auth';
import { hashPassword, hashSessionToken, verifyPassword } from './password';

type CredentialRow = {
  passwordSalt: string;
  passwordHash: string;
  passwordIterations: number;
};

export type AccountState = {
  user: AuthUser;
  role: string;
  hasPassword: boolean;
  chatGPT: {
    connected: boolean;
    email: string | null;
    connectedAt: number | null;
    lastUsedAt: number | null;
  };
};

export async function resolveChatGPTIdentity(identity: ChatGPTUser): Promise<AuthUser> {
  await initializeDb();
  const raw = getRawDb();
  const now = Date.now();
  const linkedUser = await raw.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName
    FROM auth_identities ai
    JOIN users u ON u.id = ai.user_id
    WHERE ai.provider = 'chatgpt' AND ai.provider_user_id = ?
    LIMIT 1
  `).bind(identity.userId).first<AuthUser>();

  if (linkedUser) {
    await raw.prepare(`
      UPDATE auth_identities SET provider_email = ?, last_used_at = ?
      WHERE provider = 'chatgpt' AND provider_user_id = ?
    `).bind(identity.email, now, identity.userId).run();
    return linkedUser;
  }

  const existingUser = await raw.prepare(`
    SELECT id AS userId, email, display_name AS displayName
    FROM users
    WHERE lower(email) = ?
    LIMIT 1
  `).bind(normalizeEmail(identity.email)).first<AuthUser>();

  if (existingUser) {
    await raw.prepare(`
      INSERT OR IGNORE INTO auth_identities
        (provider, provider_user_id, user_id, provider_email, created_at, last_used_at)
      VALUES ('chatgpt', ?, ?, ?, ?, ?)
    `).bind(identity.userId, existingUser.userId, identity.email, now, now).run();
    return existingUser;
  }

  return {
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
  };
}

export async function getAccountState(userId: string): Promise<AccountState> {
  await initializeDb();
  const raw = getRawDb();
  const row = await raw.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName,
      gm.role, c.user_id AS credentialUserId
    FROM users u
    JOIN game_members gm ON gm.user_id = u.id AND gm.game_id = ?
    LEFT JOIN auth_credentials c ON c.user_id = u.id
    WHERE u.id = ?
    LIMIT 1
  `).bind(GAME_ID, userId).first<AuthUser & { role: string; credentialUserId: string | null }>();
  if (!row && process.env.NODE_ENV === 'development') {
    const previewUser = await raw.prepare(`
      SELECT id AS userId, email, display_name AS displayName
      FROM users WHERE id = ? LIMIT 1
    `).bind(userId).first<AuthUser>();
    if (previewUser) {
      return {
        user: previewUser,
        role: 'owner',
        hasPassword: false,
        chatGPT: { connected: false, email: null, connectedAt: null, lastUsedAt: null },
      };
    }
  }
  if (!row) throw new Error('Карточка аккаунта недоступна: пользователь не подключён к этой игре.');

  const chatGPT = await raw.prepare(`
    SELECT provider_email AS email, created_at AS connectedAt, last_used_at AS lastUsedAt
    FROM auth_identities
    WHERE provider = 'chatgpt' AND user_id = ?
    LIMIT 1
  `).bind(userId).first<{ email: string; connectedAt: number; lastUsedAt: number }>();

  return {
    user: { userId: row.userId, email: row.email, displayName: row.displayName },
    role: row.role,
    hasPassword: Boolean(row.credentialUserId),
    chatGPT: {
      connected: Boolean(chatGPT),
      email: chatGPT?.email ?? null,
      connectedAt: chatGPT?.connectedAt ?? null,
      lastUsedAt: chatGPT?.lastUsedAt ?? null,
    },
  };
}

export async function updateAccountProfile(input: {
  userId: string;
  displayName: string;
  email: string;
  currentPassword?: string;
}): Promise<AccountState> {
  await initializeDb();
  const raw = getRawDb();
  const displayName = input.displayName.trim();
  const email = normalizeEmail(input.email);
  const current = await raw.prepare(`
    SELECT u.email, c.password_salt AS passwordSalt, c.password_hash AS passwordHash,
      c.password_iterations AS passwordIterations
    FROM users u
    LEFT JOIN auth_credentials c ON c.user_id = u.id
    WHERE u.id = ?
    LIMIT 1
  `).bind(input.userId).first<{ email: string } & Partial<CredentialRow>>();
  if (!current) throw new Error('Аккаунт не найден.');

  const conflict = await raw.prepare(
    'SELECT id FROM users WHERE lower(email) = ? AND id <> ? LIMIT 1',
  ).bind(email, input.userId).first<{ id: string }>();
  if (conflict) throw new Error('Этот email уже используется другим аккаунтом.');

  if (normalizeEmail(current.email) !== email && current.passwordHash) {
    const valid = input.currentPassword && await verifyPassword(input.currentPassword, {
      salt: current.passwordSalt ?? '',
      hash: current.passwordHash,
      iterations: current.passwordIterations ?? 0,
    });
    if (!valid) throw new Error('Чтобы изменить email, введите текущий пароль.');
  }

  const now = Date.now();
  await raw.batch([
    raw.prepare('UPDATE users SET email = ?, display_name = ? WHERE id = ?')
      .bind(email, displayName, input.userId),
    auditStatement(input.userId, 'account.profile.update', JSON.stringify({ emailChanged: normalizeEmail(current.email) !== email }), now),
  ]);
  return getAccountState(input.userId);
}

export async function changeAccountPassword(input: {
  userId: string;
  currentPassword?: string;
  newPassword: string;
  currentSessionToken?: string;
}): Promise<AccountState> {
  await initializeDb();
  const raw = getRawDb();
  const credential = await raw.prepare(`
    SELECT password_salt AS passwordSalt, password_hash AS passwordHash,
      password_iterations AS passwordIterations
    FROM auth_credentials WHERE user_id = ? LIMIT 1
  `).bind(input.userId).first<CredentialRow>();

  if (credential) {
    const valid = input.currentPassword && await verifyPassword(input.currentPassword, credential);
    if (!valid) throw new Error('Текущий пароль указан неверно.');
  }

  const password = await hashPassword(input.newPassword);
  const now = Date.now();
  const sessionHash = input.currentSessionToken
    ? await hashSessionToken(input.currentSessionToken)
    : null;
  const sessionCleanup = sessionHash
    ? raw.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?').bind(input.userId, sessionHash)
    : raw.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(input.userId);

  await raw.batch([
    raw.prepare(`
      INSERT INTO auth_credentials
        (user_id, password_salt, password_hash, password_iterations, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        password_iterations = excluded.password_iterations,
        updated_at = excluded.updated_at
    `).bind(input.userId, password.salt, password.hash, password.iterations, now, now),
    sessionCleanup,
    auditStatement(input.userId, credential ? 'account.password.change' : 'account.password.create', '{}', now),
  ]);
  return getAccountState(input.userId);
}

export async function connectChatGPTIdentity(
  userId: string,
  identity: ChatGPTUser,
): Promise<AccountState> {
  await getAccountState(userId);
  const raw = getRawDb();
  const linkedBySubject = await raw.prepare(`
    SELECT user_id AS userId FROM auth_identities
    WHERE provider = 'chatgpt' AND provider_user_id = ? LIMIT 1
  `).bind(identity.userId).first<{ userId: string }>();
  if (linkedBySubject && linkedBySubject.userId !== userId) {
    throw new Error('Эта учётная запись ChatGPT уже подключена к другой карточке.');
  }
  const linkedByUser = await raw.prepare(`
    SELECT provider_user_id AS providerUserId FROM auth_identities
    WHERE provider = 'chatgpt' AND user_id = ? LIMIT 1
  `).bind(userId).first<{ providerUserId: string }>();
  if (linkedByUser && linkedByUser.providerUserId !== identity.userId) {
    throw new Error('К карточке уже подключена другая учётная запись ChatGPT.');
  }

  const now = Date.now();
  await raw.batch([
    raw.prepare(`
      INSERT INTO auth_identities
        (provider, provider_user_id, user_id, provider_email, created_at, last_used_at)
      VALUES ('chatgpt', ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_user_id) DO UPDATE SET
        provider_email = excluded.provider_email,
        last_used_at = excluded.last_used_at
    `).bind(identity.userId, userId, identity.email, now, now),
    auditStatement(userId, linkedBySubject ? 'account.identity.refresh' : 'account.identity.connect', JSON.stringify({ provider: 'chatgpt' }), now),
  ]);
  return getAccountState(userId);
}

function auditStatement(userId: string, action: string, detailJson: string, createdAt: number) {
  return getRawDb().prepare(`
    INSERT INTO audit_logs (id, game_id, user_id, action, entity_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), GAME_ID, userId, action, userId, detailJson, createdAt);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
