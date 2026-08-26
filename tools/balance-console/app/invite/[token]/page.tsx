import { redirect } from 'next/navigation';
import { getOptionalCurrentUser } from '@/lib/current-user';
import { InviteClient } from './invite-client';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getOptionalCurrentUser();
  if (!user) redirect(`/login?invite=${encodeURIComponent(token)}`);
  return <InviteClient token={token} />;
}
