import { execFileSync, spawn } from 'node:child_process';

let token;
try {
  token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  console.error('GitHub CLI не авторизован. Выполните gh auth login и повторите запуск.');
  process.exit(1);
}

if (!token) {
  console.error('GitHub CLI не вернул токен. Выполните gh auth login и повторите запуск.');
  process.exit(1);
}

const repository = process.env.GITHUB_REPOSITORY || 'dima7272-netizen/mininggame';
let account = 'текущий аккаунт';
let canPush = false;
try {
  account = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  canPush = execFileSync('gh', ['api', `repos/${repository}`, '--jq', '.permissions.push'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() === 'true';
} catch {
  canPush = false;
}

const disabledReason = canPush
  ? ''
  : `GitHub-аккаунт ${account} может читать ${repository}, но не может записывать. Владелец репозитория должен выдать этому аккаунту роль Write, затем сервис нужно перезапустить.`;

const child = spawn('pnpm', ['dev'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GITHUB_TOKEN: canPush ? token : '',
    GITHUB_REPOSITORY: repository,
    GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
    PUBLISH_ADAPTER: canPush ? 'github' : 'disabled',
    PUBLISH_DISABLED_REASON: disabledReason,
    ALLOW_REAL_PROD: process.env.ALLOW_REAL_PROD || 'false',
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
