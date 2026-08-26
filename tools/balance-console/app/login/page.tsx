import { redirect } from 'next/navigation';
import { getAuthPageState, safeReturnPath } from '@/lib/app-auth';
import { getOptionalCurrentUser } from '@/lib/current-user';
import { AuthForm } from './auth-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; returnTo?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnPath(params.returnTo);
  const currentUser = await getOptionalCurrentUser();
  if (currentUser) {
    if (params.invite) redirect(`/invite/${encodeURIComponent(params.invite)}`);
    redirect(returnTo);
  }
  const state = await getAuthPageState(params.invite);
  return <AuthForm inviteToken={params.invite} returnTo={returnTo} state={state} />;
}
