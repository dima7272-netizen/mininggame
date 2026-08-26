import { requireChatGPTUser } from '../../chatgpt-auth';
import { InviteClient } from './invite-client';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await requireChatGPTUser(`/invite/${encodeURIComponent(token)}`);
  return <InviteClient token={token} />;
}
