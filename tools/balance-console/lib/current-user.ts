import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getChatGPTUser, type ChatGPTUser } from '@/app/chatgpt-auth';
import { getRawDb } from '@/db';
import { initializeDb } from '@/db/runtime';
import { getSessionUser, safeReturnPath, SESSION_COOKIE } from './app-auth';

export type AppUser = { userId: string; email: string; displayName: string };

export async function getOptionalCurrentUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const user = token ? await getSessionUser(token) : null;
  if (user) return user;
  if (process.env.NODE_ENV === 'development' && process.env.AUTH_LOCAL_PREVIEW !== 'true') {
    return { userId: 'local-owner', email: 'owner@dig.local', displayName: 'Локальный владелец' };
  }
  const chatGPTUser = await getChatGPTUser();
  if (chatGPTUser) return resolveChatGPTUser(chatGPTUser);
  return null;
}

async function resolveChatGPTUser(user: ChatGPTUser): Promise<AppUser> {
  await initializeDb();
  const existingUser = await getRawDb().prepare(`
    SELECT id AS userId, email, display_name AS displayName
    FROM users
    WHERE lower(email) = ?
    LIMIT 1
  `).bind(user.email.trim().toLowerCase()).first<AppUser>();

  return existingUser ?? {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
  };
}

export async function getCurrentUser(): Promise<AppUser> {
  const user = await getOptionalCurrentUser();
  if (user) return user;
  throw new Error('Сессия завершилась. Войдите в сервис снова.');
}

export async function requireCurrentUser(returnTo: string): Promise<AppUser> {
  const user = await getOptionalCurrentUser();
  if (user) return user;
  redirect(`/login?returnTo=${encodeURIComponent(safeReturnPath(returnTo))}`);
}
