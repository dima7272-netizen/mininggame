import { BalanceConsole } from '@/components/balance-console';
import { seedConfigText, seedGitSha } from '@/lib/generated/seed-configs';
import { requireCurrentUser } from '@/lib/current-user';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requireCurrentUser('/');
  return <BalanceConsole initialConfigs={{ ...seedConfigText }} initialSha={seedGitSha} />;
}
