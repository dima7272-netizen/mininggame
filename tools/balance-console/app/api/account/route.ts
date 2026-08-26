import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { assertSameOrigin, SESSION_COOKIE } from '@/lib/app-auth';
import {
  changeAccountPassword,
  connectChatGPTIdentity,
  getAccountState,
  updateAccountProfile,
} from '@/lib/account';
import { getCurrentUser } from '@/lib/current-user';

export const dynamic = 'force-dynamic';

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update_profile'),
    displayName: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(254),
    currentPassword: z.string().max(128).optional(),
  }),
  z.object({
    action: z.literal('change_password'),
    currentPassword: z.string().max(128).optional(),
    newPassword: z.string().min(12).max(128),
  }),
  z.object({ action: z.literal('connect_chatgpt') }),
]);

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json({ account: await getAccountState(user.userId) }, noStore());
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await getCurrentUser();
    const input = schema.parse(await request.json());
    let account;
    if (input.action === 'update_profile') {
      account = await updateAccountProfile({ userId: user.userId, ...input });
    } else if (input.action === 'change_password') {
      const cookieStore = await cookies();
      account = await changeAccountPassword({
        userId: user.userId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        currentSessionToken: cookieStore.get(SESSION_COOKIE)?.value,
      });
    } else {
      const chatGPTUser = await getChatGPTUser();
      if (!chatGPTUser) throw new Error('Сначала подтвердите вход в учётную запись ChatGPT.');
      account = await connectChatGPTIdentity(user.userId, chatGPTUser);
    }
    return NextResponse.json({ account }, noStore());
  } catch (error) {
    return failure(error);
  }
}

function noStore() {
  return { headers: { 'Cache-Control': 'no-store' } };
}

function failure(error: unknown) {
  const message = error instanceof z.ZodError
    ? 'Проверьте заполненные поля. Новый пароль должен содержать не меньше 12 символов.'
    : error instanceof Error ? error.message : 'Не удалось сохранить настройки аккаунта.';
  return NextResponse.json({ error: message }, { status: 400, ...noStore() });
}
