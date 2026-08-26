import { getRawDb } from '@/db';
import { GAME_ID, ensureBootstrap } from '@/db/repository';
import { initializeDb } from '@/db/runtime';
import { hashPassword, hashSessionToken, randomSessionToken, verifyPassword } from './password';

export const SESSION_COOKIE = 'dig_balance_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type AuthUser = {
  userId: string;
  email: string;
  displayName: string;
};

type CredentialRow = AuthUser & {
  passwordSalt: string;
  passwordHash: string;
  passwordIterations: number;
};

type InvitationRow = {
  id: string;
  role: string;
  permissionsJson: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revokedAt: number | null;
};

export type AuthPageState = {
  registrationAllowed: boolean;
  bootstrapRegistration: boolean;
  invitationValid: boolean;
  invitationMessage: string | null;
};

export async function getAuthPageState(inviteToken?: string): Promise<AuthPageState> {
  await initializeDb();
  const raw = getRawDb();
  const credentials = await raw.prepare('SELECT COUNT(*) AS count FROM auth_credentials').first<{ count: number }>();
  const bootstrapRegistration = Number(credentials?.count ?? 0) === 0;
  if (!inviteToken) {
    return {
      registrationAllowed: bootstrapRegistration,
      bootstrapRegistration,
      invitationValid: false,
      invitationMessage: null,
    };
  }

  const invitation = await findInvitation(inviteToken);
  const invitationMessage = invitationProblem(invitation);
  return {
    registrationAllowed: invitationMessage === null || bootstrapRegistration,
    bootstrapRegistration,
    invitationValid: invitationMessage === null,
    invitationMessage,
  };
}

export async function registerAccount(input: {
  displayName: string;
  email: string;
  password: string;
  inviteToken?: string;
}): Promise<{ user: AuthUser; sessionToken: string }> {
  await initializeDb();
  const raw = getRawDb();
  const now = Date.now();
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  const credentials = await raw.prepare('SELECT COUNT(*) AS count FROM auth_credentials').first<{ count: number }>();
  const isBootstrap = Number(credentials?.count ?? 0) === 0;
  const existingUser = await raw.prepare(
    'SELECT id AS userId, email, display_name AS displayName FROM users WHERE lower(email) = ? LIMIT 1',
  ).bind(email).first<AuthUser>();
  const existingOwner = await raw.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName
    FROM game_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.game_id = ? AND gm.role = 'owner'
    LIMIT 1
  `).bind(GAME_ID).first<AuthUser>();

  let user: AuthUser;
  let invitation: InvitationRow | null = null;

  if (isBootstrap) {
    if (existingOwner && normalizeEmail(existingOwner.email) !== email) {
      throw new Error('Для первого входа укажите email владельца, который уже подключал сервис.');
    }
    user = {
      userId: existingOwner?.userId ?? existingUser?.userId ?? crypto.randomUUID(),
      email,
      displayName,
    };
    await ensureBootstrap(user);
  } else {
    if (!input.inviteToken) throw new Error('Регистрация доступна только по ссылке-приглашению от владельца.');
    invitation = await findInvitation(input.inviteToken);
    const problem = invitationProblem(invitation);
    if (problem) throw new Error(problem);
    user = {
      userId: existingUser?.userId ?? crypto.randomUUID(),
      email,
      displayName,
    };
  }

  const credentialExists = await raw.prepare(
    'SELECT user_id FROM auth_credentials WHERE user_id = ? LIMIT 1',
  ).bind(user.userId).first<{ userId: string }>();
  if (credentialExists) throw new Error('Аккаунт с таким email уже зарегистрирован. Войдите с паролем.');

  const password = await hashPassword(input.password);
  if (isBootstrap) {
    await raw.prepare(`
      INSERT INTO auth_credentials (user_id, password_salt, password_hash, password_iterations, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(user.userId, password.salt, password.hash, password.iterations, now, now).run();
  } else if (invitation) {
    const existingMember = await raw.prepare(
      'SELECT role FROM game_members WHERE game_id = ? AND user_id = ? LIMIT 1',
    ).bind(GAME_ID, user.userId).first<{ role: string }>();
    await raw.batch([
      raw.prepare(`
        INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name
      `).bind(user.userId, user.email, user.displayName, now),
      raw.prepare(`
        INSERT INTO auth_credentials (user_id, password_salt, password_hash, password_iterations, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(user.userId, password.salt, password.hash, password.iterations, now, now),
      raw.prepare(`
        INSERT OR IGNORE INTO game_members (game_id, user_id, role, permissions_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(GAME_ID, user.userId, invitation.role, invitation.permissionsJson, now),
      raw.prepare('UPDATE invitations SET uses = uses + 1 WHERE id = ? AND uses = ? AND revoked_at IS NULL')
        .bind(invitation.id, invitation.uses),
      raw.prepare(`
        INSERT INTO audit_logs (id, game_id, user_id, action, entity_id, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        GAME_ID,
        user.userId,
        'invitation.accept',
        invitation.id,
        JSON.stringify({ role: existingMember?.role ?? invitation.role, registration: 'password' }),
        now,
      ),
    ]);
  }

  return { user, sessionToken: await createSession(user.userId) };
}

export async function loginAccount(input: {
  email: string;
  password: string;
}): Promise<{ user: AuthUser; sessionToken: string }> {
  await initializeDb();
  const raw = getRawDb();
  const row = await raw.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName,
      c.password_salt AS passwordSalt, c.password_hash AS passwordHash,
      c.password_iterations AS passwordIterations
    FROM users u
    JOIN auth_credentials c ON c.user_id = u.id
    JOIN game_members gm ON gm.user_id = u.id AND gm.game_id = ?
    WHERE lower(u.email) = ?
    LIMIT 1
  `).bind(GAME_ID, normalizeEmail(input.email)).first<CredentialRow>();

  const valid = row && await verifyPassword(input.password, {
    salt: row.passwordSalt,
    hash: row.passwordHash,
    iterations: row.passwordIterations,
  });
  if (!row || !valid) throw new Error('Неверный email или пароль.');

  return {
    user: { userId: row.userId, email: row.email, displayName: row.displayName },
    sessionToken: await createSession(row.userId),
  };
}

export async function getSessionUser(sessionToken: string): Promise<AuthUser | null> {
  await initializeDb();
  const raw = getRawDb();
  const tokenHash = await hashSessionToken(sessionToken);
  const row = await raw.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName, s.expires_at AS expiresAt
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN game_members gm ON gm.user_id = u.id AND gm.game_id = ?
    WHERE s.token_hash = ?
    LIMIT 1
  `).bind(GAME_ID, tokenHash).first<AuthUser & { expiresAt: number }>();
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    await raw.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { userId: row.userId, email: row.email, displayName: row.displayName };
}

export async function deleteSession(sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await initializeDb();
  await getRawDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
    .bind(await hashSessionToken(sessionToken)).run();
}

async function createSession(userId: string): Promise<string> {
  const raw = getRawDb();
  const token = randomSessionToken();
  const now = Date.now();
  await raw.batch([
    raw.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now),
    raw.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hashSessionToken(token), userId, now, now + SESSION_MAX_AGE_SECONDS * 1000),
  ]);
  return token;
}

async function findInvitation(token: string): Promise<InvitationRow | null> {
  if (token.length < 20 || token.length > 200) return null;
  return getRawDb().prepare(`
    SELECT id, role, permissions_json AS permissionsJson, expires_at AS expiresAt,
      max_uses AS maxUses, uses, revoked_at AS revokedAt
    FROM invitations
    WHERE game_id = ? AND token_hash = ?
    LIMIT 1
  `).bind(GAME_ID, await hashSessionToken(token)).first<InvitationRow>();
}

function invitationProblem(invitation: InvitationRow | null): string | null {
  if (!invitation || invitation.revokedAt !== null) return 'Ссылка приглашения недействительна или отозвана.';
  if (invitation.expiresAt <= Date.now()) return 'Срок действия приглашения истёк.';
  if (invitation.uses >= invitation.maxUses) return 'Лимит использований приглашения исчерпан.';
  return null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function safeReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://app.local');
    if (url.origin !== 'https://app.local' || url.pathname.startsWith('/api/auth')) return '/';
    if (url.pathname === '/login') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new Error('Запрос отклонён проверкой безопасности. Обновите страницу и повторите.');
  }
}
