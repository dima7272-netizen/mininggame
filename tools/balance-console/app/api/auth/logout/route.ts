import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { assertSameOrigin, deleteSession, SESSION_COOKIE } from '@/lib/app-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const cookieStore = await cookies();
    await deleteSession(cookieStore.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({ ok: true, redirectTo: '/login' }, {
      headers: { 'Cache-Control': 'no-store' },
    });
    response.cookies.set(SESSION_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Не удалось выйти.',
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
}
