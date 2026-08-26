import { NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptInvitation } from '@/db/repository';
import { getCurrentUser } from '@/lib/current-user';

export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().min(20).max(200) });

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const result = await acceptInvitation({ user: await getCurrentUser(), token: input.token });
    return NextResponse.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? 'Ссылка приглашения повреждена.'
      : error instanceof Error ? error.message : 'Не удалось принять приглашение.';
    return NextResponse.json({ error: message }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
