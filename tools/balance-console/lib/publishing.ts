import type { ConfigTextMap } from './config-model';
import { canonicalExactJson } from './exact-json';

export type VersionStatus =
  | 'draft'
  | 'ready_dev'
  | 'published_dev'
  | 'tested'
  | 'published_prod'
  | 'rolled_back';

export type PublishEnvironment = 'DEV' | 'PROD';

export type PublishReceipt = {
  operationId: string;
  environment: PublishEnvironment;
  checksum: string;
  verified: boolean;
  publishedAt: string;
  detail: string;
};

export type PublishingInfo = {
  adapter: 'github' | 'disabled';
  devReady: boolean;
  prodReady: boolean;
  repository: string;
  branch: string;
  detail: string;
};

export type RebasePreparation = {
  headSha: string;
  configs: ConfigTextMap;
  remoteChanged: string[];
  userChanged: string[];
};

type MergeInput = {
  base: Partial<ConfigTextMap>;
  remote: Partial<ConfigTextMap>;
  target: ConfigTextMap;
};

export function nextStatus(
  current: VersionStatus,
  action: 'mark_ready' | 'publish_dev' | 'approve_testing' | 'publish_prod' | 'rollback',
): VersionStatus {
  const transitions: Record<VersionStatus, Partial<Record<typeof action, VersionStatus>>> = {
    draft: { mark_ready: 'ready_dev', rollback: 'rolled_back' },
    ready_dev: { publish_dev: 'published_dev', rollback: 'rolled_back' },
    published_dev: { approve_testing: 'tested', rollback: 'rolled_back' },
    tested: { publish_prod: 'published_prod', rollback: 'rolled_back' },
    published_prod: { rollback: 'rolled_back' },
    rolled_back: {},
  };
  const result = transitions[current][action];
  if (!result) throw new Error(`Действие ${action} недоступно для статуса ${current}.`);
  return result;
}

/** Explicit test-only publisher. Application routes never select this adapter. */
export class MockPublisher {
  async publish(
    environment: PublishEnvironment,
    versionId: string,
    configs: ConfigTextMap,
  ): Promise<PublishReceipt> {
    const checksum = await hashConfigBundle(configs);
    const publishedAt = new Date().toISOString();
    return {
      operationId: `mock-${environment.toLowerCase()}-${versionId}-${checksum.slice(0, 8)}`,
      environment,
      checksum,
      verified: true,
      publishedAt,
      detail: 'Имитация для автоматического теста: внешние системы не изменялись.',
    };
  }
}

export function getPublishingInfo(): PublishingInfo {
  const repository = process.env.GITHUB_REPOSITORY?.trim() || 'dima7272-netizen/mininggame';
  const branch = process.env.GITHUB_BRANCH?.trim() || 'main';
  const enabled = process.env.PUBLISH_ADAPTER === 'github' && Boolean(process.env.GITHUB_TOKEN?.trim());
  const disabledReason = process.env.PUBLISH_DISABLED_REASON?.trim();
  return {
    adapter: enabled ? 'github' : 'disabled',
    devReady: enabled,
    prodReady: enabled && process.env.ALLOW_REAL_PROD === 'true',
    repository,
    branch,
    detail: enabled
      ? 'Настоящая публикация: GitHub Actions отправляет конфиги в Roblox и проверяет их чтением из DEV.'
      : disabledReason || 'Настоящая публикация отключена: запустите сервис командой pnpm dev:github.',
  };
}

export function isRealDeployment(operationId: string, environment: PublishEnvironment): boolean {
  return operationId.startsWith(`github-${environment.toLowerCase()}-`);
}

export function mergeRemoteConfigBundle(input: MergeInput): {
  configs: ConfigTextMap;
  remoteChanged: string[];
  userChanged: string[];
} {
  const configs: ConfigTextMap = {};
  const conflicts: string[] = [];
  const remoteChanged: string[] = [];
  const userChanged: string[] = [];

  for (const name of Object.keys(input.target).sort()) {
    const base = canonicalOrMissing(input.base[name]);
    const remote = canonicalOrMissing(input.remote[name]);
    const target = canonicalExactJson(input.target[name]);
    const userDidChange = target !== base;
    const remoteDidChange = remote !== base;

    if (userDidChange) userChanged.push(name);
    if (remoteDidChange) remoteChanged.push(name);
    if (userDidChange && remoteDidChange && target !== remote) conflicts.push(name);
    configs[name] = userDidChange ? target : (input.remote[name] ? canonicalExactJson(input.remote[name]) : target);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `GitHub main и черновик одновременно изменили конфиги: ${conflicts.join(', ')}. Сначала перенесите эти правки вручную.`,
    );
  }
  return { configs, remoteChanged, userChanged };
}

export class GitHubPublisher {
  private readonly token: string;
  private readonly repository: string;
  private readonly branch: string;

  constructor() {
    const info = getPublishingInfo();
    if (!info.devReady) throw new Error(info.detail);
    this.token = process.env.GITHUB_TOKEN!.trim();
    this.repository = info.repository;
    this.branch = info.branch;
  }

  async prepareRebase(baseSha: string, target: ConfigTextMap): Promise<RebasePreparation> {
    await this.assertWriteAccess();
    const headSha = await this.getBranchHead();
    const names = Object.keys(target).sort();
    const [baseSources, remoteSources] = await Promise.all([
      this.readConfigs(names, baseSha),
      this.readConfigs(names, headSha),
    ]);
    const merged = mergeRemoteConfigBundle({ base: baseSources, remote: remoteSources, target });
    return { headSha, ...merged };
  }

  async assertWriteAccess() {
    const repository = await this.github<{ permissions?: { push?: boolean } }>('');
    if (!repository.permissions?.push) {
      throw new Error(`У текущего GitHub-аккаунта нет права Write для ${this.repository}. DEV не изменён.`);
    }
  }

  async publish(
    environment: PublishEnvironment,
    versionId: string,
    configs: ConfigTextMap,
    expectedHeadSha?: string,
  ): Promise<PublishReceipt> {
    const info = getPublishingInfo();
    if (environment === 'PROD' && !info.prodReady) {
      throw new Error('Настоящая публикация PROD отключена. DEV можно обновлять независимо.');
    }
    const checksum = await hashConfigBundle(configs);
    const headSha = await this.getBranchHead();
    if (expectedHeadSha && expectedHeadSha !== headSha) {
      throw new Error('GitHub main изменился во время подготовки. Повторите публикацию — сервис заново объединит изменения.');
    }
    const treeSha = await this.createTree(headSha, environment, versionId, checksum, configs);
    const commitSha = await this.createCommit(headSha, treeSha, environment, versionId);
    await this.updateBranch(headSha, commitSha);
    const expectedRuns = await this.ensureActionsStarted(commitSha, environment);
    const runs = await this.waitForActions(commitSha, environment, expectedRuns);
    const failed = runs.filter((run) => run.conclusion !== 'success');
    if (failed.length > 0) {
      throw new Error(
        `GitHub принял коммит ${commitSha.slice(0, 7)}, но публикация ${environment} завершилась ошибкой: ${failed.map((run) => run.html_url).join(', ')}`,
      );
    }
    return {
      operationId: `github-${environment.toLowerCase()}-${commitSha}`,
      environment,
      checksum,
      verified: true,
      publishedAt: new Date().toISOString(),
      detail: `GitHub ${commitSha.slice(0, 7)} · ${runs.length} workflow успешно отправили и перечитали конфиги ${environment}.`,
    };
  }

  private async readConfigs(names: string[], ref: string): Promise<Partial<ConfigTextMap>> {
    const entries = await Promise.all(names.map(async (name) => {
      const source = await this.getText(`configs/${name}.json`, ref, true);
      return [name, source] as const;
    }));
    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
  }

  private async getBranchHead(): Promise<string> {
    const data = await this.github<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(this.branch)}`,
    );
    return data.object.sha;
  }

  private async getText(path: string, ref: string, allowMissing = false): Promise<string | undefined> {
    const response = await this.request(
      `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      { headers: { Accept: 'application/vnd.github.raw+json' } },
    );
    if (response.status === 404 && allowMissing) return undefined;
    if (!response.ok) throw await githubError(response);
    return response.text();
  }

  private async createTree(
    parentCommit: string,
    environment: PublishEnvironment,
    versionId: string,
    checksum: string,
    configs: ConfigTextMap,
  ): Promise<string> {
    const targets = environment === 'DEV'
      ? { universeId: '10516693405', placeId: '123007481584347' }
      : { universeId: '10590998713', placeId: '104830450645212' };
    const marker = `${JSON.stringify({
      target: environment.toLowerCase(),
      environment,
      ...targets,
      versionId,
      checksum,
      requestedAt: new Date().toISOString(),
      source: 'Dig Get Stronger Balance Console',
    }, null, 2)}\n`;
    const tree = [
      ...Object.entries(configs).sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => ({
        path: `configs/${name}.json`, mode: '100644', type: 'blob', content: canonicalExactJson(content),
      })),
      { path: `.deploy/${environment.toLowerCase()}.json`, mode: '100644', type: 'blob', content: marker },
    ];
    const parent = await this.github<{ tree: { sha: string } }>(`/git/commits/${parentCommit}`);
    const result = await this.github<{ sha: string }>('/git/trees', {
      method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
    });
    return result.sha;
  }

  private async createCommit(parent: string, tree: string, environment: PublishEnvironment, versionId: string) {
    const result = await this.github<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: `deploy(${environment.toLowerCase()}): balance console ${versionId}`,
        tree,
        parents: [parent],
      }),
    });
    return result.sha;
  }

  private async updateBranch(expectedHead: string, commitSha: string) {
    const response = await this.request(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: 'PATCH', body: JSON.stringify({ sha: commitSha, force: false }),
    });
    if (!response.ok) {
      const currentHead = await this.getBranchHead().catch(() => 'unknown');
      if (currentHead !== expectedHead) {
        throw new Error('GitHub main изменился до фиксации публикации. Повторите операцию.');
      }
      throw await githubError(response);
    }
  }

  private async ensureActionsStarted(commitSha: string, environment: PublishEnvironment): Promise<number> {
    const workflows = await this.environmentWorkflows(environment);
    if (workflows.length === 0) {
      throw new Error(`В ${this.repository} не найден активный workflow публикации ${environment}.`);
    }

    const pushDeadline = Date.now() + 8_000;
    while (Date.now() < pushDeadline) {
      const runs = await this.actionRuns(commitSha, environment, 'push');
      if (runs.length > 0) return workflows.length;
      await delay(1_000);
    }

    for (const workflow of workflows) {
      const response = await this.request(`/actions/workflows/${workflow.id}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: this.branch }),
      });
      if (![200, 204].includes(response.status)) throw await githubError(response);
    }

    return workflows.length;
  }

  private async environmentWorkflows(environment: PublishEnvironment): Promise<GitHubWorkflow[]> {
    const data = await this.github<{ workflows: GitHubWorkflow[] }>('/actions/workflows?per_page=100');
    const needle = `deploy-${environment.toLowerCase()}`;
    return data.workflows.filter((workflow) =>
      workflow.state === 'active'
      && (workflow.name.toUpperCase().includes(environment) || workflow.path.toLowerCase().includes(needle)),
    );
  }

  private async actionRuns(
    commitSha: string,
    environment: PublishEnvironment,
    event?: 'push' | 'workflow_dispatch',
  ): Promise<ActionRun[]> {
    const eventFilter = event ? `&event=${event}` : '';
    const data = await this.github<{ workflow_runs: ActionRun[] }>(
      `/actions/runs?head_sha=${encodeURIComponent(commitSha)}${eventFilter}&per_page=100`,
    );
    return data.workflow_runs.filter((run) =>
      run.name.toUpperCase().includes(environment) || run.path.toLowerCase().includes(`deploy-${environment.toLowerCase()}`),
    );
  }

  private async waitForActions(
    commitSha: string,
    environment: PublishEnvironment,
    expectedRuns: number,
  ): Promise<ActionRun[]> {
    const deadline = Date.now() + 150_000;
    let matching: ActionRun[] = [];
    while (Date.now() < deadline) {
      matching = await this.actionRuns(commitSha, environment);
      if (matching.length >= expectedRuns && matching.every((run) => run.status === 'completed')) return matching;
      await delay(1_500);
    }
    throw new Error(
      `Коммит ${commitSha.slice(0, 7)} создан, но GitHub Actions не успел подтвердить ${environment}. Проверьте Actions перед повтором.`,
    );
  }

  private async github<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      const error = await githubError(response);
      throw new Error(`${error.message} · ${init?.method ?? 'GET'} ${path.split('?')[0]}`);
    }
    return response.json() as Promise<T>;
  }

  private request(path: string, init: RequestInit = {}) {
    return fetch(`https://api.github.com/repos/${this.repository}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dig-get-stronger-balance-console',
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  }
}

type ActionRun = {
  name: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

type GitHubWorkflow = {
  id: number;
  name: string;
  path: string;
  state: string;
};

export async function hashConfigBundle(configs: ConfigTextMap): Promise<string> {
  const canonical = Object.fromEntries(
    Object.entries(configs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, source]) => [name, canonicalExactJson(source)]),
  );
  const data = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertProdEligibility(input: {
  versionId: string;
  devVersionId: string | null;
  testedVersionId: string | null;
  status: VersionStatus;
}) {
  if (input.status !== 'tested') throw new Error('Версия ещё не подтверждена тестировщиком.');
  if (input.devVersionId !== input.versionId || input.testedVersionId !== input.versionId) {
    throw new Error('В PROD можно отправить только тот же неизменяемый набор JSON, который проверен в DEV.');
  }
}

function canonicalOrMissing(source: string | undefined) {
  return source === undefined ? '__MISSING_CONFIG__' : canonicalExactJson(source);
}

async function githubError(response: Response) {
  const body = await response.text();
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { message?: string };
    detail = parsed.message ?? detail;
  } catch {
    // Text response is already bounded and never includes request headers.
  }
  return new Error(`GitHub API ${response.status}: ${detail}`);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
