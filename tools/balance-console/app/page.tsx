import { BalanceConsole } from '@/components/balance-console';
import { seedConfigText, seedGitSha } from '@/lib/generated/seed-configs';

export default function Home() {
  return <BalanceConsole initialConfigs={{ ...seedConfigText }} initialSha={seedGitSha} />;
}
