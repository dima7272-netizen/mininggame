import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assertSameOrigin,
  registerAccount,
  safeReturnPath,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/app-auth';

export const dynamic = 'force-dynamic';

const schema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  inviteToken: z.string().min(20).max(200).optional(),
  returnTo: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    const result = await registerAccount(input);
    const response = NextResponse.json({
      ok: true,
      user: result.user,
      redirectTo: safeReturnPath(input.returnTo),
    }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set(SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    const message = error instanceof z.ZodError
      ? 'Проверьте имя, email и пароль. Пароль должен содержать не меньше 12 символов.'
      : error instanceof Error ? error.message : 'Не удалось создать аккаунт.';
    return NextResponse.json({ error: message }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
