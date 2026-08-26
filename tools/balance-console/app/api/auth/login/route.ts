import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assertSameOrigin,
  loginAccount,
  safeReturnPath,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/app-auth';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  returnTo: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    const result = await loginAccount(input);
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
      ? 'Введите корректный email и пароль.'
      : error instanceof Error ? error.message : 'Не удалось войти.';
    return NextResponse.json({ error: message }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
