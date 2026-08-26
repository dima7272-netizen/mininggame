import { BalanceConsole } from '@/components/balance-console';
import { seedConfigText, seedGitSha } from '@/lib/generated/seed-configs';
import { requireChatGPTUser } from './chatgpt-auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requireChatGPTUser('/');
  return <BalanceConsole initialConfigs={{ ...seedConfigText }} initialSha={seedGitSha} />;
}
