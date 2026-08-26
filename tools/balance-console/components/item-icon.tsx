'use client';

/* eslint-disable @next/next/no-img-element */
import { useState } from 'react';
import entityManifest from '@/data/entity-icons.json';
import iconManifest from '@/data/item-icons.json';

export type ItemIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type EntityIconCategory = keyof typeof entityManifest.categories;

export type IconEntry = { assetId: string; src: string; displayName?: string };

export function getItemIcon(itemId: string) {
  return iconManifest.items[itemId as keyof typeof iconManifest.items];
}

export function hasItemIcon(itemId: string) {
  return Boolean(getItemIcon(itemId));
}

export function getEntityIcon(category: EntityIconCategory, entityId: string): IconEntry | undefined {
  const items = entityManifest.categories[category].items as Record<string, IconEntry>;
  return items[entityId];
}

export function ItemIcon({ itemId, size = 'md', className = '' }: { itemId: string; size?: ItemIconSize; className?: string }) {
  const entry = getItemIcon(itemId);
  return <IconImage entry={entry} label={itemId} size={size} className={className} />;
}

export function GameEntityIcon({ category, entityId, size = 'md', className = '' }: { category: EntityIconCategory; entityId: string; size?: ItemIconSize; className?: string }) {
  const entry = getEntityIcon(category, entityId);
  return <IconImage entry={entry} label={entityId} size={size} className={className} />;
}

function IconImage({ entry, label, size, className }: { entry?: IconEntry; label: string; size: ItemIconSize; className: string }) {
  const [failed, setFailed] = useState(false);
  const missing = !entry || failed;

  return <span className={`item-icon item-icon-${size} ${missing ? 'missing' : ''} ${className}`} title={missing ? `Иконка не найдена: ${label}` : `${label} · Roblox asset ${entry.assetId}`}>
    {missing
      ? <span aria-label={`Иконка не найдена для ${label}`}>?</span>
      : <img src={entry.src} alt={`Иконка ${label}`} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </span>;
}

export function ItemIconDiagnostics({ itemIds }: { itemIds: string[] }) {
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const rows = itemIds
    .map((itemId) => ({ itemId, entry: getItemIcon(itemId) }))
    .filter((row) => (!query.trim() || row.itemId.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')))
      && (!onlyMissing || !row.entry));
  const available = itemIds.filter(hasItemIcon).length;

  return <section className="icon-diagnostics">
    <header className="panel icon-diagnostics-summary">
      <div><p className="eyebrow">Проверка настоящих изображений</p><h2>Иконки предметов</h2><p>Источник — авторская таблица игры <code>{iconManifest.source.path}</code>. Внешние временные ссылки в интерфейсе не используются.</p></div>
      <div className="icon-diagnostics-counts"><span><small>Найдено</small><strong>{available}</strong></span><span><small>Не найдено</small><strong>{itemIds.length - available}</strong></span><span><small>Всего SellItems</small><strong>{itemIds.length}</strong></span></div>
    </header>
    <div className="panel icon-diagnostics-toolbar"><label><span>Поиск по ID</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например, Cardboard_C" /></label><label className="reward-checkbox"><input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} /><span>Только отсутствующие</span></label></div>
    <article className="panel icon-diagnostics-table"><div className="table-scroll"><table className="data-table"><thead><tr><th>Иконка</th><th>Технический ID</th><th>Roblox asset ID</th><th>Источник в игре</th><th>Локальный файл сервиса</th><th>Статус</th></tr></thead><tbody>{rows.map(({ itemId, entry }) => <tr key={itemId}><td><ItemIcon itemId={itemId} size="lg" /></td><td><code>{itemId}</code></td><td>{entry ? <code>{entry.assetId}</code> : '—'}</td><td><code>{entry?.sourcePath ?? '—'}</code></td><td><code>{entry?.src ?? '—'}</code></td><td><span className={`icon-status ${entry ? 'ready' : 'missing'}`}>{entry ? 'Готово' : 'Иконка не найдена'}</span></td></tr>)}</tbody></table></div></article>
  </section>;
}
