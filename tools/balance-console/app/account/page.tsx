import { chatGPTSignInPath, getChatGPTUser } from '@/app/chatgpt-auth';
import { ensureBootstrap } from '@/db/repository';
import { getAccountState } from '@/lib/account';
import { requireCurrentUser } from '@/lib/current-user';
import { AccountSettings } from './account-settings';

export const dynamic = 'force-dynamic';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string }>;
}) {
  const params = await searchParams;
  const user = await requireCurrentUser('/account');
  await ensureBootstrap(user);
  const chatGPTUser = await getChatGPTUser();
  return <AccountSettings
    initialState={await getAccountState(user.userId)}
    chatGPTAvailable={Boolean(chatGPTUser)}
    chatGPTSignInUrl={chatGPTSignInPath('/account?connect=chatgpt')}
    connectRequested={params.connect === 'chatgpt'}
  />;
}
