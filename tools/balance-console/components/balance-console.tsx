'use client';

import Decimal from 'decimal.js';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ExactInput } from './exact-input';
import { GameEntityIcon, hasItemIcon, ItemIcon, type EntityIconCategory } from './item-icon';
import { LineChart } from './line-chart';
import { RewardMapEditor } from './reward-map-editor';
import { buildRebirthPreview, buildRoomEconomy, formatExact, log10ForChart } from '@/lib/analytics';
import { diffConfigs, type ConfigChange } from '@/lib/config-diff';
import { parseKnownConfigs, type ConfigTextMap, type KnownConfigs } from '@/lib/config-model';
import {
  exactNumber,
  parseExactJson,
  stringifyExactJson,
  updateAtPointer,
  type ExactJson,
} from '@/lib/exact-json';
import { hasPermission, permissions, roleLabels, rolePermissions, type Permission, type Role } from '@/lib/rbac';
import { serializeRoomDrops } from '@/lib/reward-progression';
import { createSmoothProgressionDraft } from '@/lib/progression-draft';
import { spreadsheetPreviewSnapshot } from '@/lib/source-snapshots';
import { validateConfigs, type ValidationIssue, type ValidationResult } from '@/lib/validation';
import type { VersionStatus } from '@/lib/publishing';
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  saveThemeMode,
  subscribeTheme,
  type ThemeMode,
} from '@/lib/theme';

type Section =
  | 'overview'
  | 'rooms'
  | 'rewards'
  | 'pickaxes'
  | 'pets'
  | 'upgrades'
  | 'rebirth'
  | 'arenas'
  | 'spiders'
  | 'configs'
  | 'simulator'
  | 'sources'
  | 'versions'
  | 'team';

type WorkspaceVersion = {
  id: string;
  baseVersionId: string | null;
  baseSha: string;
  contentHash: string;
  createdAt: number;
  name: string;
  notes: string;
  comment: string;
  changeSummary: ConfigChange[];
  rollbackTargetVersionId: string | null;
  configs: ConfigTextMap;
  validation: ValidationResult;
  status: VersionStatus;
  source: string;
};

type WorkspacePayload = {
  game: { id: string; name: string; timezone: string };
  publishing: {
    adapter: 'github' | 'disabled';
    devReady: boolean;
    prodReady: boolean;
    repository: string;
    branch: string;
    detail: string;
  };
  settings: { ownerTimezone: string; backupHour: string; backupTimezone: string; updatedAt: number } | null;
  goals: Array<{ id: string; label: string; metric: string; targetValue: string; unit: string; createdAt: number }>;
  invitations: Array<{ id: string; role: string; expiresAt: number; maxUses: number; uses: number; revokedAt: number | null; createdAt: number }>;
  user: { userId: string; email: string; displayName: string };
  access: { role: Role; extraPermissions: Permission[] };
  versions: WorkspaceVersion[];
  deployments: Array<{
    id: string;
    versionId: string;
    environment: string;
    status: string;
    operationId: string;
    checksum: string;
    detail: string;
    startedAt: number;
  }>;
  snapshots: Array<{
    environment: string;
    versionId: string | null;
    sha: string | null;
    checksum: string;
    verified: boolean;
    updatedAt: number;
    configs: ConfigTextMap;
  }>;
  logs: Array<{ id: string; action: string; entityId: string | null; createdAt: number; detail: unknown }>;
};

const navGroups: Array<{ label: string; items: Array<[Section, string, string]> }> = [
  {
    label: 'Настройка игры',
    items: [
      ['overview', 'Обзор', '⌂'],
      ['rooms', 'Комнаты и награды', '▦'],
      ['rewards', 'Карта наград', '▥'],
      ['pickaxes', 'Кирки', '⛏'],
      ['pets', 'Питомцы', '◆'],
      ['upgrades', 'Улучшения', '↗'],
      ['rebirth', 'Ребёрты', '↻'],
      ['arenas', 'Арены', '◎'],
      ['spiders', 'Пауки', '✳'],
      ['configs', 'Все конфиги', '{ }'],
    ],
  },
  {
    label: 'Проверка и выпуск',
    items: [
      ['simulator', 'Симулятор', '◫'],
      ['sources', 'Сравнение источников', '⇄'],
      ['versions', 'Версии и публикации', '◷'],
      ['team', 'Команда и права', '♙'],
    ],
  },
];

const statusLabels: Record<VersionStatus, string> = {
  draft: 'Черновик',
  ready_dev: 'Готово к DEV',
  published_dev: 'Опубликовано в DEV',
  tested: 'Протестировано',
  published_prod: 'Опубликовано в PROD',
  rolled_back: 'Откачено',
};

const themeModes: Array<{ id: ThemeMode; icon: string; label: string; title: string }> = [
  { id: 'light', icon: '☀', label: 'День', title: 'Светлая тема' },
  { id: 'dark', icon: '☾', label: 'Ночь', title: 'Тёмная тема' },
  { id: 'auto', icon: 'A', label: 'Авто', title: 'Как в системе' },
];

export function BalanceConsole({ initialConfigs, initialSha }: { initialConfigs: ConfigTextMap; initialSha: string }) {
  const [section, setSection] = useState<Section>('overview');
  const [environment, setEnvironment] = useState<'DEV' | 'PROD'>('DEV');
  const [configs, setConfigs] = useState<ConfigTextMap>(initialConfigs);
  const [baseConfigs, setBaseConfigs] = useState<ConfigTextMap>(initialConfigs);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('Новая настройка баланса');
  const [saveNotes, setSaveNotes] = useState('Плавная прогрессия HP и наград');
  const themeSnapshot = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const [themeMode, resolvedTheme] = themeSnapshot.split(':') as [ThemeMode, 'light' | 'dark'];

  const known = useMemo(() => parseKnownConfigs(configs), [configs]);
  const validation = useMemo(
    () => validateConfigs(configs, { comparison: spreadsheetPreviewSnapshot }),
    [configs],
  );
  const economy = useMemo(() => buildRoomEconomy(known), [known]);
  const publishedConfigs = useMemo(
    () => workspace?.snapshots.find((snapshot) => snapshot.environment === 'PROD_OBSERVED')?.configs
      ?? spreadsheetPreviewSnapshot,
    [workspace],
  );
  const publishedEconomy = useMemo(() => buildRoomEconomy(publishedConfigs), [publishedConfigs]);
  const changes = useMemo(() => diffConfigs(baseConfigs, configs), [baseConfigs, configs]);
  const latestVersion = workspace?.versions[0] ?? null;

  const refreshWorkspace = useCallback(async (syncConfigs = false) => {
    try {
      const response = await fetch('/api/workspace', { cache: 'no-store' });
      const data = await response.json() as WorkspacePayload & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Не удалось загрузить рабочее пространство.');
      setWorkspace(data);
      if (data.versions[0] && syncConfigs) {
        setBaseConfigs(data.versions[0].configs);
        setConfigs(data.versions[0].configs);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/workspace', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json() as WorkspacePayload & { error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Не удалось загрузить рабочее пространство.');
        return data;
      })
      .then((data) => {
        if (!active) return;
        setWorkspace(data);
        if (data.versions[0]) {
          setBaseConfigs(data.versions[0].configs);
          setConfigs(data.versions[0].configs);
        }
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme, themeMode]);

  function commitNode(configName: string, pointer: string, value: ExactJson) {
    setConfigs((current) => {
      const root = parseExactJson(current[configName]);
      return { ...current, [configName]: stringifyExactJson(updateAtPointer(root, pointer, value)) };
    });
  }

  function commitNumber(configName: string, pointer: string, value: string) {
    commitNode(configName, pointer, exactNumber(value));
  }

  function commitMany(configName: string, updates: Array<{ pointer: string; value: ExactJson }>) {
    setConfigs((current) => {
      let root = parseExactJson(current[configName]);
      for (const update of updates) root = updateAtPointer(root, update.pointer, update.value);
      return { ...current, [configName]: stringifyExactJson(root) };
    });
  }

  function commitRoomDrops(roomDrops: KnownConfigs['roomDrops']) {
    setConfigs((current) => ({ ...current, RoomDrops: serializeRoomDrops(roomDrops) }));
  }

  async function apiAction(body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { error?: string; workspace?: WorkspacePayload; invitation?: { path: string; note: string } };
      if (!response.ok) throw new Error(data.error ?? 'Операция не выполнена.');
      if (data.workspace) setWorkspace(data.workspace);
      else await refreshWorkspace(false);
      return data;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      return { error: detail };
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    const result = await apiAction({
      action: 'save',
      configs,
      baseVersionId: latestVersion?.id ?? null,
      baseSha: latestVersion?.baseSha ?? initialSha,
      name: saveName,
      notes: saveNotes,
    });
    if (result.workspace?.versions[0]) {
      setBaseConfigs(result.workspace.versions[0].configs);
      setConfigs(result.workspace.versions[0].configs);
      setSaveName('Новое обновление баланса');
      setSaveNotes('');
      setMessage('Новая неизменяемая версия сохранена в истории.');
    }
  }

  const mainContent = (() => {
    switch (section) {
      case 'rooms': return <RoomsScreen known={known} economy={economy} commitNumber={commitNumber} commitMany={commitMany} />;
      case 'rewards': return <RewardMapEditor
        known={known}
        economy={economy}
        canEdit={!workspace || hasPermission(workspace.access.role, 'reward-map:edit', workspace.access.extraPermissions)}
        canGenerate={!workspace || hasPermission(workspace.access.role, 'reward-map:generate', workspace.access.extraPermissions)}
        commitRoomDrops={commitRoomDrops}
        commitNumber={commitNumber}
      />;
      case 'pickaxes': return <PickaxesScreen known={known} commitNumber={commitNumber} />;
      case 'pets': return <PetsScreen known={known} commitNumber={commitNumber} />;
      case 'upgrades': return <UpgradesScreen known={known} commitNumber={commitNumber} />;
      case 'rebirth': return <RebirthScreen known={known} commitNumber={commitNumber} />;
      case 'arenas': return <ArenasScreen known={known} commitNumber={commitNumber} />;
      case 'spiders': return <SpidersScreen known={known} commitNumber={commitNumber} />;
      case 'configs': return <ConfigsScreen configs={configs} setConfigs={setConfigs} validation={validation} />;
      case 'simulator': return <SimulatorScreen known={known} economy={economy} workspace={workspace} apiAction={apiAction} />;
      case 'sources': return <SourcesScreen configs={configs} workspace={workspace} />;
      case 'versions': return <VersionsScreen
        workspace={workspace}
        busy={busy}
        apiAction={apiAction}
        onRollbackCreated={(version) => {
          setBaseConfigs(version.configs);
          setConfigs(version.configs);
          setMessage(`Создан откат «${version.name}». Проверьте его в DEV перед публикацией.`);
        }}
      />;
      case 'team': return <TeamScreen workspace={workspace} busy={busy} apiAction={apiAction} />;
      default: return <OverviewScreen
        known={known}
        economy={economy}
        publishedEconomy={publishedEconomy}
        validation={validation}
        workspace={workspace}
        onRecalculate={() => setConfigs((current) => createSmoothProgressionDraft(current))}
      />;
    }
  })();

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand brand-button" onClick={() => setSection('overview')}>
          <span className="brand-mark">D</span>
          <span><strong>Dig Get Stronger</strong><small>Баланс-центр</small></span>
        </button>
        <nav aria-label="Разделы сервиса">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map(([id, label, icon]) => (
                <button className={section === id ? 'nav-link active' : 'nav-link'} onClick={() => setSection(id)} key={id}>
                  <span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span>
                  {id === 'spiders' && validation.issues.some((item) => item.code === 'sources.spiders_drift') && <em>1</em>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="owner-avatar">{workspace?.user.displayName.slice(0, 2).toUpperCase() ?? 'ДТ'}</div>
          <span className="owner-info"><strong>{workspace?.user.displayName ?? 'Локальный владелец'}</strong><small>{roleLabels[workspace?.access.role ?? 'owner']}</small></span>
          <div className="theme-switcher" role="group" aria-label="Режим оформления">
            {themeModes.map((mode) => (
              <button
                aria-label={mode.title}
                aria-pressed={themeMode === mode.id}
                className={themeMode === mode.id ? 'selected' : ''}
                key={mode.id}
                onClick={() => saveThemeMode(mode.id)}
                title={mode.title}
              >
                <i aria-hidden="true">{mode.icon}</i><b>{mode.label}</b>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="environment" aria-label="Выбранная среда">
            <span>Среда</span>
            <button className={environment === 'DEV' ? 'selected' : ''} onClick={() => setEnvironment('DEV')}><i /> DEV</button>
            <button className={environment === 'PROD' ? 'selected prod' : ''} onClick={() => setEnvironment('PROD')}>PROD</button>
          </div>
          <div className="top-actions">
            <span className="sync-state"><i /> {workspace ? 'Хранилище подключено' : 'Локальный снимок'}</span>
            <button className="button secondary" onClick={() => setSection('sources')}>Сравнить среды</button>
            <button className="button primary" onClick={() => { setSection('configs'); setMessage('Изменяйте значения — панель сохранения появится снизу.'); }}>+ Новый черновик</button>
          </div>
        </header>
        <div className="content">{mainContent}</div>
      </section>

      {changes.length > 0 && (
        <div className="dirty-bar" role="region" aria-label="Сохранение нового обновления">
          <span className="dirty-summary"><strong>{changes.length} несохранённых изменений</strong><small>Снимок будет храниться бессрочно вместе с описанием.</small></span>
          <label className="version-meta-field"><span>Название обновления</span><input aria-label="Название обновления" value={saveName} maxLength={120} onChange={(event) => setSaveName(event.target.value)} /></label>
          <label className="version-meta-field notes"><span>Что изменено</span><textarea aria-label="Примечание к обновлению" value={saveNotes} maxLength={2000} rows={2} onChange={(event) => setSaveNotes(event.target.value)} /></label>
          <span className="dirty-actions"><button className="button secondary" onClick={() => setConfigs(baseConfigs)}>Отменить всё</button><button className="button primary" disabled={busy || validation.errorCount > 0 || saveName.trim().length < 3 || saveNotes.trim().length < 3} onClick={() => void saveDraft()}>{busy ? 'Сохраняю…' : 'Сохранить версию'}</button></span>
        </div>
      )}
      {message && <button className="toast" onClick={() => setMessage(null)}>{message}<span>×</span></button>}
    </main>
  );
}

function OverviewScreen({
  known,
  economy,
  publishedEconomy,
  validation,
  workspace,
  onRecalculate,
}: {
  known: KnownConfigs;
  economy: ReturnType<typeof buildRoomEconomy>;
  publishedEconomy: ReturnType<typeof buildRoomEconomy>;
  validation: ValidationResult;
  workspace: WorkspacePayload | null;
  onRecalculate: () => void;
}) {
  const hpValues = economy.map((room) => log10ForChart(room.blockMaxHP));
  const rewardValues = economy.map((room) => log10ForChart(room.expectedItemPrice));
  const publishedHpValues = publishedEconomy.map((room) => log10ForChart(room.blockMaxHP));
  const publishedRewardValues = publishedEconomy.map((room) => log10ForChart(room.expectedItemPrice));
  const changedRooms = economy.filter((room, index) => {
    const published = publishedEconomy[index];
    return !published
      || !new Decimal(room.blockMaxHP).equals(published.blockMaxHP)
      || !new Decimal(room.expectedItemPrice).equals(published.expectedItemPrice);
  }).length;
  const hpGrowth = economy[1]?.hpGrowth ? new Decimal(economy[1].hpGrowth).toSignificantDigits(5).toString() : '—';
  const rewardGrowth = economy[1]?.rewardGrowth ? new Decimal(economy[1].rewardGrowth).toSignificantDigits(5).toString() : '—';
  const latest = workspace?.versions[0];
  return (
    <>
      <PageHeading eyebrow="Панель управления" title="Контроль баланса" subtitle="Все игровые настройки, риски и публикации в одном месте.">
        <div className="version-box"><span>Текущая версия сервиса</span><strong>{latest?.id ?? 'локальный снимок'}</strong><small>{latest ? new Date(latest.createdAt).toLocaleString('ru-RU') : 'ожидание D1'}</small></div>
      </PageHeading>
      <section className="metric-grid">
        <Metric icon="◆" label="Активные конфиги" value="9" detail="Без жёсткого лимита" tone="accent" />
        <Metric icon="✓" label="Ошибки" value={String(validation.errorCount)} detail={validation.errorCount ? 'Публикация запрещена' : 'Блокировок нет'} tone="success" />
        <Metric icon="!" label="Предупреждения" value={String(validation.warningCount)} detail="Нужно подтверждение" tone="warning" />
        <Metric icon="↔" label="Наблюдения" value={String(validation.observationCount)} detail="Не блокируют выпуск" tone="neutral" />
      </section>
      <section className="dashboard-grid">
        <article className="panel progression-panel">
          <PanelHeading
            title="Прогрессия комнат · сравнение"
            subtitle="HP и ожидаемая цена предмета · log₁₀"
            aside={<span className="draft-badge">● Новый черновик · не опубликован</span>}
          />
          <div className="progression-summary">
            <div><small>Изменено комнат</small><strong>{changedRooms} из {economy.length}</strong></div>
            <div><small>Новый рост HP</small><strong>×{hpGrowth} / комнату</strong></div>
            <div><small>Новый рост награды</small><strong>×{rewardGrowth} / комнату</strong></div>
            <div className="comparison-help"><small>Как читать</small><strong>Пунктир — было · сплошная и полоса — новое</strong></div>
            <button className="button secondary" onClick={onRecalculate}>Пересчитать плавно</button>
          </div>
          <LineChart
            labels={economy.map((room) => String(room.index))}
            series={[
              { label: 'HP · опубликовано', color: '#6b5ce7', values: publishedHpValues, dash: [8, 7], opacity: 0.62, lineWidth: 2.5, pointRadius: 0 },
              { label: 'HP · новый черновик', color: '#6b5ce7', values: hpValues },
              { label: 'Награда · опубликовано', color: '#17a87b', values: publishedRewardValues, dash: [8, 7], opacity: 0.62, lineWidth: 2.5, pointRadius: 0 },
              { label: 'Награда · новый черновик', color: '#17a87b', values: rewardValues },
            ]}
            bands={[
              { color: '#6b5ce7', before: publishedHpValues, after: hpValues },
              { color: '#17a87b', before: publishedRewardValues, after: rewardValues },
            ]}
            ariaLabel="Логарифмический график HP и ожидаемой цены предмета по 46 комнатам"
          />
        </article>
      </section>
      <section className="bottom-grid">
        <article className="panel publish-panel">
          <PanelHeading title="Путь публикации" subtitle="PROD получит только проверенную в DEV версию" aside={<span className="safe-badge">{workspace?.publishing.devReady ? 'DEV подключён' : 'DEV ждёт доступа'}</span>} />
          <PublishFlow status={latest?.status ?? 'draft'} />
        </article>
        <article className="panel facts-panel">
          <PanelHeading title="Импортировано" subtitle="Реальные данные репозитория" />
          <div className="fact-row"><span>Комнаты</span><strong>{known.rooms.length}</strong></div>
          <div className="fact-row"><span>Кирки</span><strong>{known.pickaxes.length}</strong></div>
          <div className="fact-row"><span>Записи дропа</span><strong>{known.roomDrops.reduce((sum, room) => sum + room.drops.length, 0)}</strong></div>
          <div className="fact-row"><span>Резервная копия</span><strong>{workspace?.settings ? `${workspace.settings.backupHour} · ${workspace.settings.backupTimezone}` : '02:00 · Europe/Moscow'}</strong></div>
          <div className="fact-row"><span>Часовой пояс владельца</span><strong>{workspace?.game.timezone ?? 'Europe/Lisbon'}</strong></div>
        </article>
      </section>
    </>
  );
}

function RoomsScreen({
  known,
  economy,
  commitNumber,
  commitMany,
}: {
  known: KnownConfigs;
  economy: ReturnType<typeof buildRoomEconomy>;
  commitNumber: (config: string, pointer: string, value: string) => void;
  commitMany: (config: string, updates: Array<{ pointer: string; value: ExactJson }>) => void;
}) {
  const [selectedRoom, setSelectedRoom] = useState(16);
  const [locked, setLocked] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<Array<{ index: number; before: string; after: string }> | null>(null);
  const roomDropIndex = known.roomDrops.findIndex((room) => room.index === selectedRoom);
  const roomDrop = known.roomDrops[roomDropIndex];
  const economyRow = economy.find((room) => room.index === selectedRoom);
  const sellIndex = new Map(known.sellItems.map((item, index) => [item.id, index]));

  function prepareNormalization() {
    if (!roomDrop) return;
    const lockedTotal = roomDrop.drops.reduce(
      (sum, drop, index) => locked.has(index) ? sum.plus(drop.weight) : sum,
      new Decimal(0),
    );
    const unlocked = roomDrop.drops.filter((_, index) => !locked.has(index));
    const unlockedTotal = unlocked.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0));
    const target = new Decimal(100).minus(lockedTotal);
    if (target.isNegative() || unlockedTotal.isZero()) return;
    let allocated = new Decimal(0);
    const rows = roomDrop.drops.map((drop, index) => {
      if (locked.has(index)) return { index, before: drop.weight, after: drop.weight };
      const isLast = index === roomDrop.drops.map((_, dropIndex) => dropIndex).filter((dropIndex) => !locked.has(dropIndex)).at(-1);
      const next = isLast
        ? target.minus(allocated)
        : new Decimal(drop.weight).div(unlockedTotal).mul(target).toDecimalPlaces(4);
      allocated = allocated.plus(next);
      return { index, before: drop.weight, after: next.toString() };
    });
    setPreview(rows);
  }

  return (
    <>
      <PageHeading eyebrow="Экономика" title="Комнаты и награды" subtitle="Связанный экран Rooms, RoomDrops и SellItems.">
        <label className="room-selector">Комната<select value={selectedRoom} onChange={(event) => setSelectedRoom(Number(event.target.value))}>{known.rooms.map((room) => <option value={room.index} key={room.index}>№ {room.index}</option>)}</select></label>
      </PageHeading>
      <section className="metric-grid compact-grid">
        <Metric icon="▰" label="HP блока" value={formatExact(economyRow?.blockMaxHP ?? '0').short} detail={`точно: ${economyRow?.blockMaxHP ?? '—'}`} tone="accent" />
        <Metric icon="₽" label="Средняя цена предмета" value={formatExact(economyRow?.expectedItemPrice ?? '0').short} detail="Σ(weight / Σweight × price)" tone="success" />
        <Metric icon="↗" label="Рост HP" value={economyRow?.hpGrowth ? `×${new Decimal(economyRow.hpGrowth).toSignificantDigits(4)}` : '—'} detail="К предыдущей комнате" tone="warning" />
        <Metric icon="⚖" label="Сумма весов" value={economyRow?.totalWeight ?? '0'} detail={economyRow?.totalWeight === '100' ? 'Корректно' : 'Нужна нормализация'} tone="neutral" />
      </section>
      <article className="panel editor-panel drop-editor primary-reward-list">
        <PanelHeading title={`Награды и цены · комната ${selectedRoom}`} subtitle="Все предметы выбранной комнаты, вероятность выпадения и стоимость продажи" aside={<button className="button secondary" onClick={prepareNormalization}>Нормализовать до 100</button>} />
        <div className="table-scroll"><table className="data-table"><thead><tr><th>№</th><th>Награда</th><th>Вес выпадения</th><th>Цена продажи</th><th>Вклад в среднее</th><th>Блокировка</th></tr></thead><tbody>
          {roomDrop?.drops.map((drop, index) => {
            const item = known.sellItems.find((candidate) => candidate.id === drop.itemId);
            const priceIndex = sellIndex.get(drop.itemId);
            const contribution = item ? new Decimal(drop.weight).div(100).mul(item.sellPrice).toFixed() : '0';
            return <tr key={`${drop.itemId}-${index}`}><td><strong>{index + 1}</strong></td><td><code>{drop.itemId}</code></td><td><ExactInput compact label={`Вес ${drop.itemId}`} value={drop.weight} onCommit={(value) => commitNumber('RoomDrops', `$/${roomDropIndex}/drops/${index}/weight`, value)} /></td><td>{item && priceIndex !== undefined ? <ExactInput compact label={`Цена ${drop.itemId}`} value={item.sellPrice} onCommit={(value) => commitNumber('SellItems', `$/items/${priceIndex}/sellPrice`, value)} /> : <span className="error-text">Нет цены</span>}</td><td title={contribution}>{formatExact(contribution).short}</td><td><input type="checkbox" checked={locked.has(index)} onChange={() => setLocked((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} aria-label={`Заблокировать вес ${drop.itemId}`} /></td></tr>;
          })}
        </tbody></table></div>
      </article>
      <article className="panel editor-panel">
        <PanelHeading title="Прочность и геометрия" subtitle="Большие числа редактируются как точные десятичные строки" />
        <div className="table-scroll"><table className="data-table rooms-table"><thead><tr><th>Комната</th><th>HP блока</th><th>Длина</th><th>Слои</th><th>Средняя награда</th><th>HP рост</th><th>Награда рост</th></tr></thead><tbody>
          {known.rooms.map((room, index) => {
            const metrics = economy[index];
            return <tr className={room.index === selectedRoom ? 'selected-row' : ''} key={room.index} onClick={() => setSelectedRoom(room.index)}>
              <td><strong>№ {room.index}</strong></td>
              <td><ExactInput compact label={`HP комнаты ${room.index}`} value={room.blockMaxHP} onCommit={(value) => commitNumber('Rooms', `$/rooms/${index}/blockMaxHP`, value)} /></td>
              <td><ExactInput compact label={`Длина комнаты ${room.index}`} value={room.roomLengthCells} onCommit={(value) => commitNumber('Rooms', `$/rooms/${index}/roomLengthCells`, value)} /></td>
              <td><ExactInput compact label={`Слои комнаты ${room.index}`} value={room.barrierLayers} onCommit={(value) => commitNumber('Rooms', `$/rooms/${index}/barrierLayers`, value)} /></td>
              <td title={metrics.expectedItemPrice}>{formatExact(metrics.expectedItemPrice).short}</td>
              <td>{metrics.hpGrowth ? `×${new Decimal(metrics.hpGrowth).toSignificantDigits(4)}` : '—'}</td>
              <td>{metrics.rewardGrowth ? `×${new Decimal(metrics.rewardGrowth).toSignificantDigits(4)}` : '—'}</td>
            </tr>;
          })}
        </tbody></table></div>
      </article>
      {preview && <div className="modal-backdrop"><div className="modal"><h2>Предварительный результат</h2><p>Изменения ещё не применены. Заблокированные строки останутся прежними.</p><div className="preview-list">{preview.map((row) => <div key={row.index}><code>{roomDrop?.drops[row.index].itemId}</code><span>{row.before} → <strong>{row.after}</strong></span></div>)}</div><footer><button className="button secondary" onClick={() => setPreview(null)}>Отмена</button><button className="button primary" onClick={() => { if (roomDrop) commitMany('RoomDrops', preview.map((row) => ({ pointer: `$/${roomDropIndex}/drops/${row.index}/weight`, value: exactNumber(row.after) }))); setPreview(null); }}>Применить</button></footer></div></div>}
    </>
  );
}

function PickaxesScreen({ known, commitNumber }: EditorProps) {
  return <ProgressionScreen title="Кирки" subtitle="Цена, сила и эффективность последовательности" xAxisLabel="Номер кирки" rows={known.pickaxes.map((item, index) => ({ id: item.modelName, price: item.currencyPrice, power: item.power, index }))} configName="Pickaxes" idKey="modelName" entityCategory="pickaxes" commitNumber={commitNumber} />;
}

function PetsScreen({ known, commitNumber }: EditorProps) {
  return <ProgressionScreen title="Питомцы" subtitle="Цена, сила и влияние набора питомцев" xAxisLabel="Номер питомца" rows={known.pets.map((item, index) => ({ id: item.id, price: item.currencyPrice, power: item.power, index }))} configName="Pets" idKey="id" entityCategory="pets" commitNumber={commitNumber} />;
}

type EditorProps = { known: KnownConfigs; commitNumber: (config: string, pointer: string, value: string) => void };

function ProgressionScreen({ title, subtitle, xAxisLabel, rows, configName, idKey, entityCategory, commitNumber }: {
  title: string;
  subtitle: string;
  xAxisLabel: string;
  rows: Array<{ id: string; price: string; power: string; index: number }>;
  configName: 'Pickaxes' | 'Pets';
  idKey: string;
  entityCategory: EntityIconCategory;
  commitNumber: EditorProps['commitNumber'];
}) {
  return <><PageHeading eyebrow="Прогрессия" title={title} subtitle={subtitle} /><article className="panel editor-panel"><PanelHeading title={`График · ${title.toLowerCase()}`} subtitle="Логарифм цены и силы" /><LineChart labels={rows.map((_, index) => String(index + 1))} xAxisLabel={xAxisLabel} series={[{ label: 'Цена', color: '#6b5ce7', values: rows.map((row) => log10ForChart(row.price)) }, { label: 'Сила', color: '#17a87b', values: rows.map((row) => log10ForChart(row.power)) }]} ariaLabel={`График цены и силы: ${title}`} /></article><article className="panel editor-panel entity-progression-editor"><PanelHeading title="Редактор последовательности" subtitle={`Техническое поле ${idKey} защищено от массовых операций`} /><div className="table-scroll"><table className="data-table"><thead><tr><th>Иконка</th><th>Технический ID</th><th>Цена</th><th>Сила</th><th>Рост цены</th><th>Рост силы</th><th>Цена / сила</th></tr></thead><tbody>{rows.map((row, index) => { const previous = rows[index - 1]; const priceGrowth = previous && !new Decimal(previous.price).isZero() ? new Decimal(row.price).div(previous.price) : null; const powerGrowth = previous && !new Decimal(previous.power).isZero() ? new Decimal(row.power).div(previous.power) : null; const efficiency = new Decimal(row.power).isZero() ? new Decimal(0) : new Decimal(row.price).div(row.power); const falling = priceGrowth?.lessThan(1); return <tr className={falling ? 'warning-row' : ''} key={row.id}><td><GameEntityIcon category={entityCategory} entityId={row.id} size="lg" /></td><td><code>{row.id}</code>{falling && <span className="inline-warning">Цена падает</span>}</td><td><ExactInput label={`Цена ${row.id}`} value={row.price} onCommit={(value) => commitNumber(configName, `$/${row.index}/currencyPrice`, value)} /></td><td><ExactInput label={`Сила ${row.id}`} value={row.power} onCommit={(value) => commitNumber(configName, `$/${row.index}/power`, value)} /></td><td>{priceGrowth ? `×${priceGrowth.toSignificantDigits(4)}` : '—'}</td><td>{powerGrowth ? `×${powerGrowth.toSignificantDigits(4)}` : '—'}</td><td title={efficiency.toFixed()}>{formatExact(efficiency.toFixed()).short}</td></tr>; })}</tbody></table></div></article></>;
}

function UpgradesScreen({ known, commitNumber }: EditorProps) {
  return <><PageHeading eyebrow="Прокачка" title="Улучшения" subtitle="Значения характеристик и полная стоимость уровней." /><div className="upgrade-grid">{known.upgrades.map((upgrade, upgradeIndex) => <article className="panel upgrade-card" key={upgrade.id}><PanelHeading title={upgradeLabel(upgrade.id)} subtitle={upgrade.id} aside={<GameEntityIcon category="upgrades" entityId={upgrade.id} size="xl" />} /><div className="form-grid three"><Field label="Макс. уровень"><ExactInput value={String(upgrade.maxLevel)} label={`maxLevel ${upgrade.id}`} onCommit={(value) => commitNumber('Upgrades', `$/${upgradeIndex}/maxLevel`, value)} /></Field><Field label="Базовое значение"><ExactInput value={upgrade.baseValue} label={`baseValue ${upgrade.id}`} onCommit={(value) => commitNumber('Upgrades', `$/${upgradeIndex}/baseValue`, value)} /></Field><Field label="За уровень"><ExactInput value={upgrade.valuePerLevel} label={`valuePerLevel ${upgrade.id}`} onCommit={(value) => commitNumber('Upgrades', `$/${upgradeIndex}/valuePerLevel`, value)} /></Field></div><div className="level-list"><div className="level-header"><span>Уровень</span><span>Цена</span><span>Накоплено</span></div>{upgrade.prices.map((price, priceIndex) => { const cumulative = upgrade.prices.slice(0, priceIndex + 1).reduce((sum, value) => sum.plus(value), new Decimal(0)); return <div className="level-row" key={priceIndex}><span>{priceIndex + 1}</span><ExactInput compact label={`Цена ${upgrade.id}, уровень ${priceIndex + 1}`} value={price} onCommit={(value) => commitNumber('Upgrades', `$/${upgradeIndex}/prices/${priceIndex}`, value)} /><span title={cumulative.toFixed()}>{formatExact(cumulative.toFixed()).short}</span></div>; })}</div></article>)}</div></>;
}

function RebirthScreen({ known, commitNumber }: EditorProps) {
  const curve = buildRebirthPreview(known, 120);
  return <><PageHeading eyebrow="Прогрессия" title="Ребёрты" subtitle="Первые требования и кусочная кривая роста до 120-го ребёрта." /><div className="notice unconfirmed"><strong>Интерпретация не подтверждена кодом игры</strong><p>График последовательно умножает требование на multiplier только как предпросмотр структуры конфига.</p></div><article className="panel editor-panel"><PanelHeading title="Требования" subtitle="log₁₀, ребёрты 1–120" /><LineChart labels={curve.map((_, index) => String(index + 1))} xAxisLabel="Номер ребёрта" series={[{ label: 'Требование', color: '#6b5ce7', values: curve.map(log10ForChart) }]} ariaLabel="Предпросмотр требований ребёртов" /></article><section className="split-panels"><article className="panel editor-panel"><PanelHeading title="Первые 10 требований" subtitle="firstRequirements" /><div className="simple-list">{known.rebirth.firstRequirements.map((value, index) => <Field label={`Ребёрт ${index + 1}`} key={index}><ExactInput value={value} label={`Требование ребёрта ${index + 1}`} onCommit={(next) => commitNumber('Rebirth', `$/firstRequirements/${index}`, next)} /></Field>)}</div></article><article className="panel editor-panel"><PanelHeading title="Участки роста" subtitle="growth" /><div className="simple-list">{known.rebirth.growth.map((segment, index) => <div className="form-grid two" key={index}><Field label="До ребёрта"><ExactInput value={String(segment.upTo)} label={`upTo ${index + 1}`} onCommit={(next) => commitNumber('Rebirth', `$/growth/${index}/upTo`, next)} /></Field><Field label="Множитель"><ExactInput value={segment.multiplier} label={`multiplier ${index + 1}`} onCommit={(next) => commitNumber('Rebirth', `$/growth/${index}/multiplier`, next)} /></Field></div>)}</div></article></section></>;
}

function ArenasScreen({ known, commitNumber }: EditorProps) {
  const [labels, setLabels] = useState<Record<number, string>>({ 10: 'Вероятно событийная', 12: 'Назначение не подтверждено', 13: 'Назначение не подтверждено' });
  return <><PageHeading eyebrow="Множители" title="Арены" subtitle="Порядок ID не считается прогрессией без подтверждения игрового кода." /><div className="notice"><strong>Служебные метки не попадут в игровой JSON</strong><p>Русские названия и тип арены хранятся только в интерфейсе сервиса.</p></div><article className="panel editor-panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>ID</th><th>Множитель</th><th>Требуется ребёртов</th><th>Служебная метка</th></tr></thead><tbody>{known.arenas.map((arena, index) => <tr key={arena.id}><td><code>{arena.id}</code></td><td><ExactInput label={`Множитель арены ${arena.id}`} value={arena.multiplier} onCommit={(value) => commitNumber('Arenas', `$/${index}/multiplier`, value)} /></td><td>{arena.requiredRebirths ? <ExactInput label={`Ребёрты арены ${arena.id}`} value={arena.requiredRebirths} onCommit={(value) => commitNumber('Arenas', `$/${index}/requiredRebirths`, value)} /> : <span className="muted">Нет поля</span>}</td><td><input className="service-input" value={labels[arena.id] ?? 'Обычная / не классифицирована'} onChange={(event) => setLabels((current) => ({ ...current, [arena.id]: event.target.value }))} /></td></tr>)}</tbody></table></div></article></>;
}

function SpidersScreen({ known, commitNumber }: EditorProps) {
  const preview = parseKnownConfigs({ ...spreadsheetPreviewSnapshot }).spiders;
  const labels: Record<string, string> = { visualScale: 'Визуальный размер', baseSpeedStudsPerSecond: 'Базовая скорость, studs/с', speedPerRoom: 'Прибавка скорости за комнату', maximumSpeedStudsPerSecond: 'Максимальная скорость', attackRadiusStuds: 'Радиус атаки', attackWindupSeconds: 'Задержка перед ударом', attackRecoverySeconds: 'Восстановление после удара', stateSendIntervalSeconds: 'Интервал отправки состояния' };
  return <><PageHeading eyebrow="Опасности" title="Пауки" subtitle="Понятная форма и сравнение рабочего значения с сохранённым предпросмотром." /><div className="notice unconfirmed"><strong>Формула скорости по комнате не подключена</strong><p>В репозитории нет потребителя Spiders.json. Поля редактируются точно, но график не выдаёт предположение за игровую логику.</p></div><article className="panel editor-panel"><PanelHeading title="Параметры" subtitle="Технический ключ показан рядом" /><div className="spider-grid">{Object.entries(known.spiders).map(([key, value]) => { const drift = preview[key] !== value; return <Field label={labels[key] ?? key} technical={key} key={key}><ExactInput value={value} label={labels[key] ?? key} onCommit={(next) => commitNumber('Spiders', `$/${key}`, next)} />{drift && <small className="drift-note">Предпросмотр: {preview[key]}</small>}</Field>; })}</div></article></>;
}

function ConfigsScreen({ configs, setConfigs, validation }: { configs: ConfigTextMap; setConfigs: (next: ConfigTextMap | ((current: ConfigTextMap) => ConfigTextMap)) => void; validation: ValidationResult }) {
  const [selected, setSelected] = useState(Object.keys(configs)[0]);
  const [newName, setNewName] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  function addConfig() { if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(newName) || configs[newName]) { setListError('Имя должно быть новым техническим ключом без пробелов.'); return; } setConfigs((current) => ({ ...current, [newName]: '{}\n' })); setSelected(newName); setNewName(''); setListError(null); }
  return <><PageHeading eyebrow="Универсальный редактор" title="Все конфиги" subtitle="Известные и новые JSON-конфиги без изменения кода сервиса." /><section className="configs-layout"><aside className="panel config-list"><div className="panel-heading"><div><h2>Конфиги</h2><p>{Object.keys(configs).length} активных</p></div></div>{Object.keys(configs).sort().map((name) => <button className={selected === name ? 'active' : ''} onClick={() => { setSelected(name); setListError(null); }} key={name}><code>{name}.json</code><span>{name in spreadsheetPreviewSnapshot ? 'Игровой' : 'Новый'}</span></button>)}<div className="add-config"><input placeholder="NewConfig" value={newName} onChange={(event) => setNewName(event.target.value)} /><button onClick={addConfig}>+</button></div>{listError && <p className="raw-error">{listError}</p>}</aside><RawConfigEditor key={`${selected}:${configs[selected]}`} selected={selected} source={configs[selected]} onApply={(canonical) => setConfigs((current) => ({ ...current, [selected]: canonical }))} /></section><article className="panel validation-panel"><PanelHeading title="Проверки" subtitle={`${validation.errorCount} ошибок · ${validation.warningCount} предупреждений · ${validation.observationCount} наблюдений`} /><IssueList issues={validation.issues} /></article></>;
}

function RawConfigEditor({ selected, source, onApply }: { selected: string; source: string; onApply: (canonical: string) => void }) {
  const [draft, setDraft] = useState(source);
  const [rawError, setRawError] = useState<string | null>(null);
  function applyRaw() {
    try { onApply(stringifyExactJson(parseExactJson(draft))); setRawError(null); }
    catch (error) { setRawError(error instanceof Error ? error.message : String(error)); }
  }
  return <article className="panel raw-editor"><PanelHeading title={`${selected}.json`} subtitle="Числа сохраняются без преобразования в JavaScript number" aside={<button className="button primary" onClick={applyRaw}>Применить JSON</button>} /><textarea spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />{rawError && <p className="raw-error">{rawError}</p>}</article>;
}

function SimulatorScreen({
  known,
  economy,
  workspace,
  apiAction,
}: {
  known: KnownConfigs;
  economy: ReturnType<typeof buildRoomEconomy>;
  workspace: WorkspacePayload | null;
  apiAction: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [room, setRoom] = useState(16);
  const [pickaxe, setPickaxe] = useState(known.pickaxes[0].modelName);
  const [rebirths, setRebirths] = useState(0);
  const [goalLabel, setGoalLabel] = useState('Время прохождения комнаты');
  const [goalValue, setGoalValue] = useState('60');
  const selectedPickaxe = known.pickaxes.find((item) => item.modelName === pickaxe) ?? known.pickaxes[0];
  const selectedRoom = economy.find((item) => item.index === room) ?? economy[0];
  async function saveGoal() {
    await apiAction({ action: 'save_goal', label: goalLabel, metric: 'room_time', targetValue: goalValue, unit: 'seconds' });
  }
  return <><PageHeading eyebrow="Модель игрока" title="Симулятор" subtitle="Подтверждённые данные отделены от неподключённых игровых формул." /><section className="simulator-grid"><article className="panel simulator-controls"><PanelHeading title="Экипировка" subtitle="Выберите состояние игрока" /><Field label="Комната"><select value={room} onChange={(event) => setRoom(Number(event.target.value))}>{known.rooms.map((item) => <option value={item.index} key={item.index}>Комната {item.index}</option>)}</select></Field><Field label="Кирка"><select value={pickaxe} onChange={(event) => setPickaxe(event.target.value)}>{known.pickaxes.map((item) => <option value={item.modelName} key={item.modelName}>{item.modelName}</option>)}</select></Field><Field label="Ребёрты"><input type="number" min="0" value={rebirths} onChange={(event) => setRebirths(Number(event.target.value))} /></Field><div className="goal-editor"><strong>Цель баланса</strong><Field label="Название"><input value={goalLabel} onChange={(event) => setGoalLabel(event.target.value)} /></Field><Field label="Цель, секунд"><input inputMode="decimal" value={goalValue} onChange={(event) => setGoalValue(event.target.value)} /></Field><button className="button secondary" onClick={() => void saveGoal()}>Сохранить цель</button></div></article><article className="panel simulator-results"><PanelHeading title="Результат" subtitle="Без неподтверждённых множителей" /><div className="result-grid"><Result label="HP блока" value={formatExact(selectedRoom.blockMaxHP).short} exact={selectedRoom.blockMaxHP} /><Result label="Сила кирки" value={formatExact(selectedPickaxe.power).short} exact={selectedPickaxe.power} /><Result label="Средняя цена предмета" value={formatExact(selectedRoom.expectedItemPrice).short} exact={selectedRoom.expectedItemPrice} /><Result label="Ожидаемый доход комнаты*" value={formatExact(selectedRoom.expectedRoomIncome).short} exact={selectedRoom.expectedRoomIncome} /></div><div className="formula-missing"><span>Формула не подключена</span><strong>Итоговая сила · число ударов · время комнаты · денежный бонус</strong><p>Нужны файлы игровых потребителей Pickaxes, HitStrength, Pets, Rebirth и Arenas. Ребёрты выбраны: {rebirths}, но в расчёт не добавлены.</p></div><small className="assumption">* Среднее 7,5 предмета — явно подписанное допущение. Распределение количества предметов не найдено в коде.</small><div className="saved-goals"><strong>Пользовательские цели</strong>{workspace?.goals.length ? workspace.goals.map((goal) => <span key={goal.id}>{goal.label}: <b>{goal.targetValue} {goal.unit}</b> · формула не подключена</span>) : <span>Целей пока нет.</span>}</div></article></section></>;
}

function SourcesScreen({ configs, workspace }: { configs: ConfigTextMap; workspace: WorkspacePayload | null }) {
  const sheetChanges = diffConfigs(spreadsheetPreviewSnapshot, configs);
  const prod = workspace?.snapshots.find((snapshot) => snapshot.environment === 'PROD_OBSERVED');
  const realDev = workspace?.deployments.find((item) =>
    item.environment === 'DEV' && item.status === 'verified' && item.operationId.startsWith('github-dev-'),
  );
  return <><PageHeading eyebrow="Контроль источников" title="Сравнение версий" subtitle="Рабочий черновик, GitHub, DEV и наблюдаемый PROD показываются раздельно." /><div className="source-cards"><SourceCard name="Текущий черновик" status="Рабочий" detail={`${sheetChanges.length} отличий от предпросмотра`} verified={false} /><SourceCard name="GitHub main" status="Импортирован" detail={workspace?.versions[0]?.baseSha.slice(0, 7) ?? 'локальный HEAD'} verified /><SourceCard name="DEV" status={realDev ? 'Опубликован и перечитан' : 'Не опубликован'} detail={realDev ? realDev.detail : 'Отметки старого мок-режима не считаются публикацией'} verified={Boolean(realDev)} /><SourceCard name="PROD" status="Наблюдаемый снимок" detail={prod ? new Date(prod.updatedAt).toLocaleString('ru-RU') : 'Google Sheets preview'} verified={false} /></div><article className="panel editor-panel"><PanelHeading title="Отличия от сохранённого предпросмотра" subtitle={`${sheetChanges.length} полей`} /><div className="table-scroll"><table className="data-table"><thead><tr><th>Конфиг</th><th>JSON Pointer</th><th>Предпросмотр</th><th>Текущий черновик</th></tr></thead><tbody>{sheetChanges.map((change) => <tr key={`${change.configName}-${change.path}`}><td><code>{change.configName}</code></td><td><code>{change.path}</code></td><td><ChangeValue value={change.before} /></td><td><ChangeValue value={change.after} /></td></tr>)}</tbody></table></div></article></>;
}

function VersionsScreen({
  workspace,
  busy,
  apiAction,
  onRollbackCreated,
}: {
  workspace: WorkspacePayload | null;
  busy: boolean;
  apiAction: (body: Record<string, unknown>) => Promise<unknown>;
  onRollbackCreated: (version: WorkspaceVersion) => void;
}) {
  const latest = workspace?.versions[0];
  const [showProdConfirm, setShowProdConfirm] = useState(false);
  const [prodPhrase, setProdPhrase] = useState('');
  const [rollbackTarget, setRollbackTarget] = useState<WorkspaceVersion | null>(null);
  const [rollbackReason, setRollbackReason] = useState('Возвращаю стабильные настройки после неудачного обновления.');
  const versionChanges = latest ? getStoredVersionChanges(latest, workspace?.versions ?? []) : [];
  const realDevDeployment = latest && workspace?.deployments.find((item) =>
    item.versionId === latest.id && item.environment === 'DEV' && item.status === 'verified'
    && item.operationId.startsWith('github-dev-'),
  );
  const hasRealDev = Boolean(realDevDeployment);
  const legacyMockState = Boolean(latest && ['published_dev', 'tested'].includes(latest.status) && !hasRealDev);
  const effectiveStatus: VersionStatus = legacyMockState ? 'ready_dev' : (latest?.status ?? 'draft');

  async function createRollback() {
    if (!rollbackTarget) return;
    const result = await apiAction({
      action: 'rollback',
      versionId: rollbackTarget.id,
      reason: rollbackReason,
    }) as { workspace?: WorkspacePayload };
    const created = result.workspace?.versions[0];
    if (created) onRollbackCreated(created);
    setRollbackTarget(null);
    setRollbackReason('Возвращаю стабильные настройки после неудачного обновления.');
  }

  return <>
    <PageHeading
      eyebrow="Бессрочная история"
      title="Версии и публикации"
      subtitle="Все снимки остаются в журнале по дате и названию. Откат создаёт новый черновик и никогда не стирает прошлое."
    />
    <article className="panel editor-panel">
      <PanelHeading title="Текущий маршрут" subtitle={latest ? `${latest.name} · ${statusLabels[latest.status]}` : 'Загрузка…'} />
      <PublishFlow status={effectiveStatus} />
      {legacyMockState && <div className="notice unconfirmed"><strong>DEV раньше был только имитацией</strong><p>Вы всё сделали правильно, но прежняя кнопка не меняла игру. Теперь эту версию нужно один раз отправить в настоящий DEV.</p></div>}
      {!workspace?.publishing.devReady && <div className="notice unconfirmed"><strong>Настоящая публикация не подключена</strong><p>{workspace?.publishing.detail ?? 'Проверяю подключение GitHub…'}</p></div>}
      <div className="workflow-actions">
        {latest?.status === 'draft' && <button disabled={busy} className="button primary" onClick={() => void apiAction({ action: 'mark_ready', versionId: latest.id, warningsAcknowledged: true })}>Подготовить к DEV · предупреждения просмотрены</button>}
        {latest && (latest.status === 'ready_dev' || legacyMockState) && <button disabled={busy || !workspace?.publishing.devReady} className="button primary" onClick={() => void apiAction({ action: 'publish_dev', versionId: latest.id })}>{busy ? 'Публикую и проверяю…' : 'Опубликовать настоящий DEV'}</button>}
        {latest?.status === 'published_dev' && hasRealDev && <button disabled={busy} className="button primary" onClick={() => void apiAction({ action: 'approve_testing', versionId: latest.id })}>Подтверждаю тестирование в игре</button>}
        {latest?.status === 'tested' && hasRealDev && workspace?.publishing.prodReady && <button disabled={busy} className="button danger" onClick={() => setShowProdConfirm(true)}>Перейти к подтверждению PROD</button>}
      </div>
      {latest?.status === 'tested' && hasRealDev && !workspace?.publishing.prodReady && <p className="empty-state">Тестирование подтверждено. Настоящий PROD отключён отдельно и случайно запущен быть не может.</p>}
      {showProdConfirm && latest?.status === 'tested' && <div className="prod-confirm">
        <span>Критическое подтверждение</span>
        <h3>Dig Get Stronger · {latest.name} · PROD</h3>
        <p>Будет отправлен тот же checksum, который проверен в настоящем DEV: <code>{latest.contentHash.slice(0, 16)}</code>.</p>
        <div className="confirm-summary"><strong>{versionChanges.length} изменений</strong><strong>{latest.validation.warningCount} предупреждений</strong><strong>PROD</strong></div>
        {versionChanges.slice(0, 5).map((change) => <small key={`${change.configName}-${change.path}`}>{change.configName} · {change.path}: {change.before} → {change.after}</small>)}
        <label>Введите <code>DIG GET STRONGER / PROD</code><input value={prodPhrase} onChange={(event) => setProdPhrase(event.target.value)} /></label>
        <div className="workflow-actions"><button className="button secondary" onClick={() => { setShowProdConfirm(false); setProdPhrase(''); }}>Отмена</button><button disabled={busy || prodPhrase !== 'DIG GET STRONGER / PROD'} className="button danger" onClick={() => void apiAction({ action: 'publish_prod', versionId: latest.id, confirmation: prodPhrase })}>Опубликовать настоящий PROD</button></div>
      </div>}
    </article>

    <article className="panel editor-panel history-panel">
      <PanelHeading title="История обновлений" subtitle={`${workspace?.versions.length ?? 0} снимков · без автоудаления`} />
      {rollbackTarget && <div className="rollback-confirm">
        <span className="rollback-icon" aria-hidden="true">↶</span>
        <div className="rollback-copy"><small>Подготовка безопасного отката</small><h3>Вернуть «{rollbackTarget.name}»</h3><p>Будут восстановлены настройки от {formatVersionDate(rollbackTarget.createdAt)}. Текущая и все прошлые версии останутся в истории. PROD не изменится, пока вы не проверите и не опубликуете новый черновик.</p></div>
        <label><span>Причина отката</span><textarea rows={3} maxLength={2000} value={rollbackReason} onChange={(event) => setRollbackReason(event.target.value)} /></label>
        <div className="rollback-actions"><button className="button secondary" onClick={() => setRollbackTarget(null)}>Отмена</button><button className="button danger" disabled={busy || rollbackReason.trim().length < 3} onClick={() => void createRollback()}>{busy ? 'Создаю…' : 'Создать версию отката'}</button></div>
      </div>}
      <div className="version-history">
        {workspace?.versions.map((version, index) => {
          const storedChanges = getStoredVersionChanges(version, workspace.versions);
          const isLatest = index === 0;
          return <article className={isLatest ? 'version-card current' : 'version-card'} key={version.id}>
            <header>
              <span className={`status-dot ${version.status}`} />
              <div className="version-title"><span>{isLatest ? 'Текущая версия' : version.source === 'rollback' ? 'Версия отката' : 'Сохранённое обновление'}</span><h3>{version.name}</h3></div>
              <span className="status-badge">{statusLabels[version.status]}</span>
              <time dateTime={new Date(version.createdAt).toISOString()}>{formatVersionDate(version.createdAt)}</time>
            </header>
            <p className="version-notes">{version.notes || version.comment}</p>
            {version.rollbackTargetVersionId && <p className="rollback-link">↶ Восстановлен снимок <code>{version.rollbackTargetVersionId}</code></p>}
            <div className="version-technical"><code>{version.id}</code><span>checksum {version.contentHash.slice(0, 12)}</span><span>{storedChanges.length} изменённых полей</span></div>
            <details className="version-changes">
              <summary>{storedChanges.length > 0 ? `Показать, что изменилось (${storedChanges.length})` : 'Начальный снимок без предыдущей версии'}</summary>
              {storedChanges.length > 0 && <div className="change-list">{storedChanges.map((change) => <div className="change-row" key={`${version.id}-${change.configName}-${change.path}`}><strong>{change.configName}</strong><code>{change.path}</code><span className="change-before"><ChangeValue value={change.before} /></span><i aria-hidden="true">→</i><span className="change-after"><ChangeValue value={change.after} /></span></div>)}</div>}
            </details>
            <footer className="version-actions"><a className="text-button" href={`/api/versions/${encodeURIComponent(version.id)}/export`} download>Скачать ZIP</a>{!isLatest && <button className="text-button rollback-button" disabled={busy} onClick={() => { setRollbackTarget(version); setRollbackReason(`Возвращаю стабильную версию «${version.name}».`); }}>Откатить к этой версии</button>}</footer>
          </article>;
        }) ?? <p className="empty-state">Загрузка истории…</p>}
      </div>
    </article>

    <article className="panel editor-panel">
      <PanelHeading title="Операции публикации" subtitle="Настоящие операции подтверждаются GitHub Actions и чтением данных из Roblox" />
      <div className="version-list">{workspace?.deployments.map((deployment) => { const mock = deployment.operationId.startsWith('mock-'); return <div className="version-row" key={deployment.id}><span className={`status-dot ${!mock && deployment.status === 'verified' ? 'tested' : 'rolled_back'}`} /><div><strong>{deployment.environment} · {mock ? 'имитация — игра не менялась' : deployment.status}</strong><code>{deployment.operationId}</code><small>{deployment.detail}</small></div><time>{new Date(deployment.startedAt).toLocaleString('ru-RU')}</time></div>; })}</div>
    </article>
  </>;
}

function getStoredVersionChanges(version: WorkspaceVersion, history: WorkspaceVersion[]) {
  if (version.changeSummary.length > 0) return version.changeSummary;
  const base = history.find((item) => item.id === version.baseVersionId);
  return base ? diffConfigs(base.configs, version.configs) : [];
}

function formatVersionDate(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function cleanChangeValue(value: string) {
  return value.replace(/^(?:number|string|boolean|null):/, '');
}

function ChangeValue({ value }: { value: string }) {
  const cleaned = cleanChangeValue(value);
  const possibleItemId = cleaned.replace(/^["']|["']$/g, '');
  return <span className="change-value-with-icon">{hasItemIcon(possibleItemId) && <ItemIcon itemId={possibleItemId} size="xs" />}<span>{cleaned}</span></span>;
}

function TeamScreen({ workspace, busy, apiAction }: { workspace: WorkspacePayload | null; busy: boolean; apiAction: (body: Record<string, unknown>) => Promise<{ invitation?: { path: string; note: string } } | unknown> }) {
  const [role, setRole] = useState<Role>('balancer');
  const [expires, setExpires] = useState(72);
  const [uses, setUses] = useState(1);
  const [extraPermissions, setExtraPermissions] = useState<Permission[]>([]);
  const [link, setLink] = useState<string | null>(null);
  async function invite() {
    const result = await apiAction({ action: 'invite', role, extraPermissions, expiresInHours: expires, maxUses: uses }) as { invitation?: { path: string } };
    if (result.invitation) setLink(`${location.origin}${result.invitation.path}`);
  }
  function togglePermission(permission: Permission) {
    setExtraPermissions((current) => current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission]);
  }
  return <><PageHeading eyebrow="Доступ по игре" title="Команда и права" subtitle="Регистрация закрыта; доступ выдаётся приглашениями с ограничением срока и использований." /><section className="split-panels team-panels"><article className="panel editor-panel"><PanelHeading title="Создать приглашение" subtitle="Токен хранится только как SHA-256" /><div className="simple-list"><Field label="Роль"><select value={role} onChange={(event) => { setRole(event.target.value as Role); setExtraPermissions([]); }}>{Object.entries(roleLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></Field><Field label="Срок, часов"><input type="number" min="1" max="720" value={expires} onChange={(event) => setExpires(Number(event.target.value))} /></Field><Field label="Использований"><input type="number" min="1" max="100" value={uses} onChange={(event) => setUses(Number(event.target.value))} /></Field><div className="permission-checks"><strong>Дополнительные права</strong>{permissions.filter((permission) => !rolePermissions[role].includes(permission)).map((permission) => <label key={permission}><input type="checkbox" checked={extraPermissions.includes(permission)} onChange={() => togglePermission(permission)} /> {permission}</label>)}</div><button disabled={busy} className="button primary" onClick={() => void invite()}>Создать ссылку</button>{link && <div className="invite-link"><strong>Показывается один раз</strong><code>{link}</code></div>}</div></article><article className="panel editor-panel"><PanelHeading title="Права роли" subtitle={roleLabels[role]} /><div className="permission-list">{rolePermissions[role].map((permission) => <span key={permission}>✓ {permission}</span>)}{extraPermissions.map((permission) => <span key={permission}>+ {permission}</span>)}</div><div className="current-user"><strong>Текущий пользователь</strong><span>{workspace?.user.displayName ?? 'Локальный владелец'}</span><small>{workspace?.user.email}</small></div></article></section><section className="split-panels team-panels"><article className="panel editor-panel"><PanelHeading title="Активные приглашения" subtitle="Ссылка отзывается без раскрытия токена" /><div className="version-list">{workspace?.invitations.length ? workspace.invitations.map((item) => <div className="version-row invite-row" key={item.id}><span className={`status-dot ${item.revokedAt ? 'rolled_back' : 'tested'}`} /><div><strong>{roleLabels[item.role as Role] ?? item.role}</strong><code>{item.id} · {item.uses}/{item.maxUses} использований</code></div><time>{item.revokedAt ? 'Отозвано' : `до ${new Date(item.expiresAt).toLocaleString('ru-RU')}`}</time>{!item.revokedAt && <button className="text-button" onClick={() => void apiAction({ action: 'revoke_invitation', invitationId: item.id })}>Отозвать</button>}</div>) : <p className="empty-state">Приглашений пока нет.</p>}</div></article><GameSettingsEditor key={workspace?.settings?.updatedAt ?? 'defaults'} settings={workspace?.settings ?? null} busy={busy} onSave={(settings) => apiAction({ action: 'update_settings', ...settings })} /></section></>;
}

function GameSettingsEditor({ settings, busy, onSave }: { settings: WorkspacePayload['settings']; busy: boolean; onSave: (settings: { ownerTimezone: string; backupHour: string; backupTimezone: string }) => Promise<unknown> }) {
  const [ownerTimezone, setOwnerTimezone] = useState(settings?.ownerTimezone ?? 'Europe/Lisbon');
  const [backupHour, setBackupHour] = useState(settings?.backupHour ?? '02:00');
  const [backupTimezone, setBackupTimezone] = useState(settings?.backupTimezone ?? 'Europe/Moscow');
  return <article className="panel editor-panel"><PanelHeading title="Время и резервные копии" subtitle="Импортированное расписание сохранено без изменений" /><div className="simple-list"><Field label="Часовой пояс владельца"><input value={ownerTimezone} onChange={(event) => setOwnerTimezone(event.target.value)} /></Field><Field label="Ежедневная копия"><input type="time" value={backupHour} onChange={(event) => setBackupHour(event.target.value)} /></Field><Field label="Часовой пояс копии"><input value={backupTimezone} onChange={(event) => setBackupTimezone(event.target.value)} /></Field><button disabled={busy} className="button secondary" onClick={() => void onSave({ ownerTimezone, backupHour, backupTimezone })}>Сохранить настройки</button></div></article>;
}

function PageHeading({ eyebrow, title, subtitle, children }: { eyebrow: string; title: string; subtitle: string; children?: React.ReactNode }) {
  return <section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{subtitle}</p></div>{children}</section>;
}

function PanelHeading({ title, subtitle, aside }: { title: string; subtitle: string; aside?: React.ReactNode }) {
  return <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{aside}</div>;
}

function Metric({ icon, label, value, detail, tone }: { icon: string; label: string; value: string; detail: string; tone: 'accent' | 'success' | 'warning' | 'neutral' }) {
  return <article className={`metric-card ${tone === 'accent' ? 'accent' : ''}`}><span className={`metric-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>;
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return <p className="empty-state">Проблем не найдено.</p>;
  return <div className="risk-list">{issues.map((item, index) => <div className={`risk-item ${item.severity}`} key={`${item.code}-${index}`}><span>{item.severity === 'error' ? '×' : item.severity === 'warning' ? '!' : 'i'}</span><div><strong>{item.title}</strong><p>{item.detail}</p><small>{item.configName ?? 'Аудит'} {item.path ? `· ${item.path}` : ''}</small>{item.formula && <code className="formula">{item.formula}</code>}</div><em>{item.severity === 'error' ? 'Ошибка' : item.severity === 'warning' ? 'Предупреждение' : 'Наблюдение'}</em></div>)}</div>;
}

function PublishFlow({ status }: { status: VersionStatus }) {
  const order: VersionStatus[] = ['draft', 'published_dev', 'tested', 'published_prod'];
  const rank = status === 'ready_dev' ? 0.5 : order.indexOf(status);
  return <div className="publish-flow"><FlowStep label="Импорт" detail="Базовая версия" done /><i /><FlowStep label="Черновик" detail="Проверки" done={rank > 0} current={rank === 0 || rank === .5} /><i /><FlowStep label="DEV" detail="GitHub → Roblox + проверка" done={rank > 1} current={rank === 1} /><i /><FlowStep label="Тестирование" detail="Проверка в игре" done={rank > 2} current={rank === 2} /><i /><FlowStep label="PROD" detail="Тот же JSON" done={rank === 3} current={rank === 3} locked={rank < 2} /></div>;
}

function FlowStep({ label, detail, done, current, locked }: { label: string; detail: string; done?: boolean; current?: boolean; locked?: boolean }) {
  return <div className={`flow-step ${done ? 'done' : ''} ${current ? 'current' : ''} ${locked ? 'locked' : ''}`}><span>{done ? '✓' : locked ? '⌁' : '•'}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function Field({ label, technical, children }: { label: string; technical?: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}{technical && <code>{technical}</code>}</span>{children}</label>;
}

function Result({ label, value, exact }: { label: string; value: string; exact: string }) {
  return <div className="result-card" title={`Точное значение: ${exact}`}><small>{label}</small><strong>{value}</strong><code>{exact}</code></div>;
}

function SourceCard({ name, status, detail, verified }: { name: string; status: string; detail: string; verified: boolean }) {
  return <article className="panel source-card"><span className={verified ? 'source-icon verified' : 'source-icon'}>{verified ? '✓' : '?'}</span><div><h2>{name}</h2><strong>{status}</strong><p>{detail}</p></div></article>;
}

function upgradeLabel(id: string) {
  return ({ WalkSpeed: 'Скорость ходьбы', HitStrength: 'Сила удара', CarryCapacity: 'Вместимость', PetSlots: 'Слоты питомцев' } as Record<string, string>)[id] ?? id;
}
