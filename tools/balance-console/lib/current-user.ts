import { getChatGPTUser } from '@/app/chatgpt-auth';

export type AppUser = { userId: string; email: string; displayName: string };

export async function getCurrentUser(): Promise<AppUser> {
  const user = await getChatGPTUser();
  if (user) return { userId: user.userId, email: user.email, displayName: user.displayName };
  if (process.env.NODE_ENV === 'development') {
    return { userId: 'local-owner', email: 'owner@dig.local', displayName: 'Локальный владелец' };
  }
  throw new Error('Требуется вход. Открытая регистрация отключена.');
}
