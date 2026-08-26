'use client';

import Decimal from 'decimal.js';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ItemIcon, ItemIconDiagnostics } from './item-icon';
import { LineChart } from './line-chart';
import { formatExact, type RoomEconomy } from '@/lib/analytics';
import type { KnownConfigs, RoomDrop } from '@/lib/config-model';
import { itemsForRoom } from '@/lib/game-formulas';
import {
  analyzeRewardProgression,
  applyRewardSuggestion,
  buildRewardSuggestions,
  cellKey,
  cloneRoomDrops,
  copyRoomRewards,
  countRewardChanges,
  generateRewardScheme,
  lifecycleTemplates,
  normalizeRoomDrop,
  probabilityAtLeastOnce,
  rewardStage,
  setRoomRewardWeight,
  shiftRewardScheme,
  type RewardGeneratorSettings,
  type RewardLifecycle,
  type RewardStage,
  type RewardSuggestion,
} from '@/lib/reward-progression';

type ViewMode = 'map' | 'neighbors' | 'analytics' | 'catalog' | 'suggestions' | 'generator' | 'icons';

type RewardMetadata = Record<string, {
  manualRank?: number;
  group?: string;
  protected?: boolean;
  event?: boolean;
}>;

export function RewardMapEditor({
  known,
  economy,
  canEdit,
  canGenerate,
  commitRoomDrops,
  commitNumber,
}: {
  known: KnownConfigs;
  economy: RoomEconomy[];
  canEdit: boolean;
  canGenerate: boolean;
  commitRoomDrops: (roomDrops: RoomDrop[]) => void;
  commitNumber: (config: string, pointer: string, value: string) => void;
}) {
  const analysis = useMemo(() => analyzeRewardProgression(known), [known]);
  const suggestions = useMemo(() => buildRewardSuggestions(known), [known]);
  const [mode, setMode] = useState<ViewMode>('map');
  const [selectedRoom, setSelectedRoom] = useState(known.rooms[0]?.index ?? 1);
  const [selectedItem, setSelectedItem] = useState(analysis.lifecycles[0]?.itemId ?? '');
  const [cellDraft, setCellDraft] = useState(() => known.roomDrops[0]?.drops.find((drop) => drop.itemId === analysis.lifecycles[0]?.itemId)?.weight ?? '3');
  const [spreadEnd, setSpreadEnd] = useState(known.rooms[Math.min(4, known.rooms.length - 1)]?.index ?? 1);
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState<'compact' | 'detailed'>('compact');
  const [onlySelectedRoom, setOnlySelectedRoom] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedCells, setLockedCells] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<RoomDrop[][]>([]);
  const [redoStack, setRedoStack] = useState<RoomDrop[][]>([]);
  const [previewRooms, setPreviewRooms] = useState<RoomDrop[] | null>(null);
  const [previewTitle, setPreviewTitle] = useState('Предварительный результат');
  const [previewSelection, setPreviewSelection] = useState<Set<number>>(new Set());
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [dismissTarget, setDismissTarget] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState('Осознанное решение владельца игры.');
  const [metadata, setMetadata] = useState<RewardMetadata>({});
  const [generator, setGenerator] = useState<RewardGeneratorSettings>({
    roomStart: known.rooms[0]?.index ?? 1,
    roomEnd: known.rooms.at(-1)?.index ?? 46,
    templateId: 'standard',
    maximumActive: 18,
    newRewardsPerRoom: 2,
    newRewardEvery: 1,
    minimumJackpotPercent: 1,
    highChanceHoldRooms: 1,
    minimumReplacementCount: 1,
    minimumReplacementPercent: 29,
    precision: '1',
    excludedRooms: [],
  });
  const [excludedRoomsText, setExcludedRoomsText] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const storedLocks = localStorage.getItem('dig-reward-map-locks');
        const storedMetadata = localStorage.getItem('dig-reward-map-metadata');
        const storedDismissed = localStorage.getItem('dig-reward-map-dismissed');
        if (storedLocks) setLockedCells(new Set(JSON.parse(storedLocks) as string[]));
        if (storedMetadata) setMetadata(JSON.parse(storedMetadata) as RewardMetadata);
        if (storedDismissed) setDismissed(JSON.parse(storedDismissed) as Record<string, string>);
      } catch {
        // Corrupt device-only metadata must never block editing the game JSON.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const lifecycle = analysis.lifecycleByItem.get(selectedItem);
  const selectedRoomDrop = known.roomDrops.find((room) => room.index === selectedRoom);
  const selectedDrop = selectedRoomDrop?.drops.find((drop) => drop.itemId === selectedItem);
  const selectedMetric = analysis.metricByRoom.get(selectedRoom);
  const currentCellKey = cellKey(selectedRoom, selectedItem);
  const attemptCount = itemsForRoom(selectedRoom, known.sellSettings) as 7 | 8;
  const selectedSeenChance = selectedDrop
    ? probabilityAtLeastOnce(selectedDrop.weight, attemptCount)
    : null;

  function persistLocks(next: Set<string>) {
    setLockedCells(next);
    localStorage.setItem('dig-reward-map-locks', JSON.stringify([...next]));
  }

  function updateMetadata(itemId: string, patch: RewardMetadata[string]) {
    const next = { ...metadata, [itemId]: { ...metadata[itemId], ...patch } };
    setMetadata(next);
    localStorage.setItem('dig-reward-map-metadata', JSON.stringify(next));
  }

  function applyRooms(next: RoomDrop[], message: string) {
    setUndoStack((current) => [...current.slice(-29), cloneRoomDrops(known.roomDrops)]);
    setRedoStack([]);
    commitRoomDrops(next);
    setCellDraft(next.find((room) => room.index === selectedRoom)?.drops.find((drop) => drop.itemId === selectedItem)?.weight ?? '3');
    setNotice(message);
  }

  function undo() {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current.slice(-29), cloneRoomDrops(known.roomDrops)]);
    commitRoomDrops(previous);
    setNotice('Последнее изменение карты отменено.');
  }

  function redo() {
    const next = redoStack.at(-1);
    if (!next) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current.slice(-29), cloneRoomDrops(known.roomDrops)]);
    commitRoomDrops(next);
    setNotice('Изменение карты повторено.');
  }

  function changeSelectedCell(normalize: boolean) {
    try {
      const next = setRoomRewardWeight(
        known.roomDrops,
        selectedRoom,
        selectedItem,
        cellDraft,
        normalize,
        lockedCells,
        generator.precision,
      );
      applyRooms(next, normalize ? 'Процент изменён, остальные незаблокированные награды нормализованы.' : 'Процент записан без изменения остальных значений. Проверка суммы обновлена.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function removeSelectedCell() {
    try {
      const next = setRoomRewardWeight(known.roomDrops, selectedRoom, selectedItem, null, true, lockedCells, generator.precision);
      applyRooms(next, 'Награда удалена из комнаты, оставшиеся значения нормализованы.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function normalizeSelectedRoom() {
    try {
      if (!selectedRoomDrop) return;
      const normalized = normalizeRoomDrop(selectedRoomDrop, lockedCells, generator.precision);
      applyRooms(known.roomDrops.map((room) => room.index === selectedRoom ? normalized : cloneRoomDrops([room])[0]), `Комната ${selectedRoom} нормализована ровно до 100%.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function scaleSelectedReward(multiplier: string) {
    try {
      let next = cloneRoomDrops(known.roomDrops);
      next = next.map((room) => {
        const drop = room.drops.find((item) => item.itemId === selectedItem);
        if (!drop || lockedCells.has(cellKey(room.index, selectedItem))) return room;
        drop.weight = new Decimal(drop.weight).mul(multiplier).toString();
        return normalizeRoomDrop(room, lockedCells, generator.precision);
      });
      applyRooms(next, `Все незаблокированные значения ${selectedItem} изменены на ${new Decimal(multiplier).mul(100).toString()}% от прежнего.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function spreadSelectedValue() {
    try {
      const start = Math.min(selectedRoom, spreadEnd);
      const end = Math.max(selectedRoom, spreadEnd);
      let next = cloneRoomDrops(known.roomDrops);
      for (let roomIndex = start; roomIndex <= end; roomIndex += 1) {
        if (lockedCells.has(cellKey(roomIndex, selectedItem))) continue;
        next = setRoomRewardWeight(next, roomIndex, selectedItem, cellDraft, true, lockedCells, generator.precision);
      }
      applyRooms(next, `${cellDraft}% для ${selectedItem} протянуто по комнатам ${start}–${end} с нормализацией.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function makeSuggestionPreview(suggestion: RewardSuggestion) {
    try {
      const next = applyRewardSuggestion(known, suggestion, lockedCells, generator.precision);
      setPreviewRooms(next);
      setPreviewTitle(suggestion.title);
      setPreviewSelection(new Set(suggestion.rooms));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function createGeneratorPreview() {
    try {
      const excludedRooms = parseRoomList(excludedRoomsText);
      const protectedLocks = new Set(lockedCells);
      Object.entries(metadata).forEach(([itemId, itemMetadata]) => {
        if (!itemMetadata.protected) return;
        known.roomDrops.forEach((room) => {
          if (room.drops.some((drop) => drop.itemId === itemId)) protectedLocks.add(cellKey(room.index, itemId));
        });
      });
      const rankOverrides = Object.fromEntries(Object.entries(metadata)
        .filter(([, itemMetadata]) => itemMetadata.manualRank !== undefined)
        .map(([itemId, itemMetadata]) => [itemId, itemMetadata.manualRank as number]));
      const next = generateRewardScheme(known, { ...generator, excludedRooms, rankOverrides }, protectedLocks);
      setPreviewRooms(next);
      setPreviewTitle(`${lifecycleTemplates[generator.templateId].name} шаблон · комнаты ${generator.roomStart}–${generator.roomEnd}`);
      setPreviewSelection(new Set(next.filter((room) => room.index >= generator.roomStart && room.index <= generator.roomEnd && !excludedRooms.includes(room.index)).map((room) => room.index)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function applyPreview() {
    if (!previewRooms) return;
    const previewByRoom = new Map(previewRooms.map((room) => [room.index, room]));
    const merged = known.roomDrops.map((room) => previewSelection.has(room.index)
      ? cloneRoomDrops([previewByRoom.get(room.index) ?? room])[0]
      : cloneRoomDrops([room])[0]);
    applyRooms(merged, `Применено комнат: ${previewSelection.size}. Изменения остаются в черновике до сохранения версии.`);
    setPreviewRooms(null);
  }

  function selectCell(itemId: string, roomIndex: number) {
    setSelectedItem(itemId);
    setSelectedRoom(roomIndex);
    setCellDraft(known.roomDrops.find((room) => room.index === roomIndex)?.drops.find((drop) => drop.itemId === itemId)?.weight ?? '3');
  }

  const filteredLifecycles = analysis.lifecycles.filter((item) => {
    const matchesSearch = !search.trim() || item.itemId.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'));
    const matchesRoom = !onlySelectedRoom || item.placements.some((placement) => placement.roomIndex === selectedRoom);
    return matchesSearch && matchesRoom;
  });

  return <div className="reward-map-page">
    <header className="reward-map-heading">
      <div><p className="eyebrow">Визуальный редактор RoomDrops</p><h1>Карта наград</h1><p>{known.sellItems.length} наград × {known.rooms.length} комнат · точные проценты, жизненные циклы, предложения и безопасный генератор черновика.</p></div>
      <div className="reward-map-summary"><ItemIcon itemId={selectedItem} size="lg" /><div><span>Выбрано</span><strong>{selectedItem || '—'}</strong><small>Комната {selectedRoom} · {selectedDrop?.weight ?? 0}%</small></div></div>
    </header>

    <nav className="reward-view-tabs" aria-label="Режим карты наград">
      {([
        ['map', 'Тепловая карта'],
        ['neighbors', 'Комната и следующие'],
        ['analytics', 'Графики и показатели'],
        ['catalog', 'Каталог и цены'],
        ['suggestions', `Предложения · ${suggestions.filter((item) => !dismissed[item.id]).length}`],
        ['generator', 'Автогенератор'],
        ['icons', 'Проверка иконок'],
      ] as Array<[ViewMode, string]>).map(([id, label]) => <button className={mode === id ? 'active' : ''} key={id} onClick={() => setMode(id)}>{label}</button>)}
    </nav>

    {notice && <button className="reward-notice" onClick={() => setNotice(null)}>{notice}<span>×</span></button>}

    {mode === 'map' && <>
      <section className="panel reward-map-toolbar">
        <label><span>Поиск награды</span><input type="search" placeholder="Технический ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label><span>Выбранная комната</span><select value={selectedRoom} onChange={(event) => selectCell(selectedItem, Number(event.target.value))}>{known.rooms.map((room) => <option key={room.index} value={room.index}>Комната {room.index}</option>)}</select></label>
        <label><span>Масштаб</span><select value={zoom} onChange={(event) => setZoom(event.target.value as typeof zoom)}><option value="compact">Все комнаты</option><option value="detailed">Подробный</option></select></label>
        <label className="reward-checkbox"><input type="checkbox" checked={onlySelectedRoom} onChange={(event) => setOnlySelectedRoom(event.target.checked)} /><span>Только активные в комнате {selectedRoom}</span></label>
        <div className="map-history-actions"><button disabled={!canEdit || undoStack.length === 0} onClick={undo}>↶ Отменить</button><button disabled={!canEdit || redoStack.length === 0} onClick={redo}>↷ Повторить</button></div>
      </section>

      {selectedMetric && <section className="reward-interest-strip">
        <span><small>Активные типы</small><strong>{selectedMetric.activeCount}</strong><i>+{selectedMetric.newCount} новых · {selectedMetric.lastCount} в последней комнате</i></span>
        <span><small>Выбранная награда за комнату</small><strong>{selectedSeenChance === null ? '—' : `${selectedSeenChance}%`}</strong><i>хотя бы раз из {attemptCount}</i></span>
        <span><small>Ожидаемая цена</small><strong>{formatExact(selectedMetric.expectedItemPrice).short}</strong><i>Σ(вес × цена)</i></span>
        <span><small>Ожидаемо за комнату*</small><strong>{formatExact(selectedMetric.expectedRoomIncome).short}</strong><i>ровно {attemptCount} предметов</i></span>
        <span><small>Устаревшие награды</small><strong>{selectedMetric.staleWeight}%</strong><i>цена ниже 20% средней</i></span>
        <span><small>Новизна*</small><strong>{selectedMetric.noveltyIndex}/100</strong><i>новые типы + их стартовая доля</i></span>
        <span><small>Захламление*</small><strong>{selectedMetric.clutterIndex}/100</strong><i>типы сверх 9 + слабая доля</i></span>
        <span><small>Джекпот*</small><strong>{selectedMetric.jackpotIndex}/100</strong><i>новые предметы дороже средней</i></span>
        <details><summary>* Как читать</summary><p>Это условные расчётные индикаторы сервиса, а не фактическое поведение игроков. Они нужны только для сравнения соседних комнат.</p></details>
      </section>}

      <RewardCellEditor
        canEdit={canEdit}
        lifecycle={lifecycle}
        metadata={metadata[selectedItem]}
        itemId={selectedItem}
        roomIndex={selectedRoom}
        weight={selectedDrop?.weight ?? null}
        draft={cellDraft}
        roomTotal={selectedRoomDrop?.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).toString() ?? '0'}
        locked={lockedCells.has(currentCellKey)}
        onDraft={setCellDraft}
        onApply={changeSelectedCell}
        onRemove={removeSelectedCell}
        onNormalize={normalizeSelectedRoom}
        onToggleLock={() => {
          const next = new Set(lockedCells);
          if (next.has(currentCellKey)) next.delete(currentCellKey); else next.add(currentCellKey);
          persistLocks(next);
        }}
        onCopyPrevious={() => {
          try {
            applyRooms(copyRoomRewards(known.roomDrops, selectedRoom - 1, selectedRoom, lockedCells), `Схема комнаты ${selectedRoom - 1} скопирована в комнату ${selectedRoom}.`);
          } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
        }}
        onShift={(direction) => {
          try { applyRooms(shiftRewardScheme(known.roomDrops, direction, lockedCells), `Вся схема перенесена на одну комнату ${direction > 0 ? 'вперёд' : 'назад'}.`); }
          catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
        }}
        spreadEnd={spreadEnd}
        onSpreadEnd={setSpreadEnd}
        onSpread={spreadSelectedValue}
        onScale={scaleSelectedReward}
        onMetadata={(patch) => updateMetadata(selectedItem, patch)}
      />

      <article className={`panel reward-heatmap-panel ${zoom}`}>
        <div className="heatmap-legend"><div><strong>Тепловая карта процентов</strong><span>{filteredLifecycles.length} наград · нажмите ячейку для точного редактирования</span></div><div className="stage-legend"><span className="new">Новая</span><span className="rising">▲ Растёт</span><span className="high">Большой шанс</span><span className="last">Последняя</span><span className="removed">0% · удалена</span><span className="locked">■ Блок</span></div></div>
        <div className="reward-heatmap-scroll"><table className="reward-heatmap"><thead><tr><th className="reward-name-column"><span>Награда · цена</span></th>{known.rooms.map((room) => {
          const metric = analysis.metricByRoom.get(room.index);
          const roomEconomy = economy.find((item) => item.index === room.index);
          return <th className={room.index === selectedRoom ? 'selected-column' : ''} key={room.index}><button onClick={() => setSelectedRoom(room.index)}><strong>{room.index}</strong><small>HP {formatExact(room.blockMaxHP).short}</small><i>{metric?.activeCount ?? 0} акт. · +{metric?.newCount ?? 0}</i><em>{formatExact(roomEconomy?.expectedItemPrice ?? '0').short}</em></button></th>;
        })}</tr></thead><tbody>{filteredLifecycles.map((item) => <RewardHeatmapRow
          key={item.itemId}
          lifecycle={item}
          known={known}
          selectedItem={selectedItem}
          selectedRoom={selectedRoom}
          lockedCells={lockedCells}
          onSelect={selectCell}
        />)}</tbody></table></div>
      </article>

      {lifecycle && <LifecyclePanel lifecycle={lifecycle} known={known} metadata={metadata[selectedItem]} onMetadata={(patch) => updateMetadata(selectedItem, patch)} />}
    </>}

    {mode === 'neighbors' && <NeighborsView
      known={known}
      analysis={analysis}
      selectedRoom={selectedRoom}
      selectedItem={selectedItem}
      onRoom={(room) => selectCell(selectedItem, room)}
      onCell={selectCell}
    />}

    {mode === 'analytics' && <RewardAnalyticsView
      known={known}
      analysis={analysis}
      selectedRoom={selectedRoom}
      selectedItem={selectedItem}
      onRoom={setSelectedRoom}
    />}

    {mode === 'catalog' && <RewardCatalog known={known} analysis={analysis} commitNumber={commitNumber} onSelect={(itemId) => { setSelectedItem(itemId); setMode('map'); }} />}

    {mode === 'suggestions' && <section className="suggestion-layout">
      <article className="panel suggestion-rules"><h2>Как формируются предложения</h2><p>Правила объяснимы и работают локально: вход новой награды выше 3%, небезопасное удаление после большого шанса, больше 11 типов, слабые предметы выше 20% пула, три комнаты без новизны, повторные появления и отставание награды от HP.</p><details><summary>Защита резкого удаления</summary><p>Удаление сразу в 0% считается нормальным только когда более сильные награды действительно получают освободившийся шанс, ожидаемая ценность не падает и шанс хорошей награды не ухудшается.</p></details><details><summary>Условные показатели</summary><p><b>Новизна</b> — число новых предметов и их джекпотная доля. <b>Захламление</b> — число типов сверх девяти и доля предметов дешевле 20% средней цены. <b>Джекпот</b> — доля новых предметов дороже средней цены. Это расчётные индикаторы, не поведение игроков.</p></details></article>
      <div className="suggestion-list">{suggestions.filter((suggestion) => !dismissed[suggestion.id]).map((suggestion) => <article className={`panel suggestion-card ${suggestion.severity}`} key={suggestion.id}><header><span>{suggestion.severity === 'warning' ? '!' : 'i'}</span><div><small>{suggestion.rooms.map((room) => `Комната ${room}`).join(' · ')}</small><h3>{suggestion.title}</h3></div></header><p>{suggestion.reason}</p><div className="suggestion-proposal"><strong>Предлагаемое изменение</strong><span>{suggestion.proposal}</span><small>Прогноз: {suggestion.impact}</small></div>{suggestion.itemIds.length > 0 && <div className="suggestion-items">{suggestion.itemIds.slice(0, 8).map((itemId) => <span className="suggestion-item" key={itemId}><ItemIcon itemId={itemId} size="xs" /><code>{itemId}</code></span>)}</div>}<footer><button className="button secondary" onClick={() => { setSelectedRoom(suggestion.rooms[0]); if (suggestion.itemIds[0]) setSelectedItem(suggestion.itemIds[0]); setMode('map'); }}>Показать на карте</button><button className="button primary" disabled={!canEdit} onClick={() => makeSuggestionPreview(suggestion)}>Предпросмотр</button><button className="text-button" onClick={() => setDismissTarget(suggestion.id)}>Отклонить</button></footer>{dismissTarget === suggestion.id && <div className="dismiss-reason"><label>Причина<input value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} /></label><button disabled={dismissReason.trim().length < 3} onClick={() => { const next = { ...dismissed, [suggestion.id]: dismissReason.trim() }; setDismissed(next); localStorage.setItem('dig-reward-map-dismissed', JSON.stringify(next)); setDismissTarget(null); }}>Сохранить отклонение</button></div>}</article>)}</div>
    </section>}

    {mode === 'generator' && <GeneratorView
      settings={generator}
      setSettings={setGenerator}
      excludedRoomsText={excludedRoomsText}
      setExcludedRoomsText={setExcludedRoomsText}
      canGenerate={canGenerate}
      lockedCount={lockedCells.size}
      protectedCount={Object.values(metadata).filter((item) => item.protected).length}
      onPreview={createGeneratorPreview}
    />}

    {mode === 'icons' && <ItemIconDiagnostics itemIds={known.sellItems.map((item) => item.id)} />}

    {previewRooms && <PreviewPanel
      title={previewTitle}
      before={known.roomDrops}
      after={previewRooms}
      known={known}
      selectedRooms={previewSelection}
      onToggleRoom={(roomIndex) => {
        const next = new Set(previewSelection);
        if (next.has(roomIndex)) next.delete(roomIndex); else next.add(roomIndex);
        setPreviewSelection(next);
      }}
      onCancel={() => setPreviewRooms(null)}
      onApply={applyPreview}
      canEdit={canEdit}
    />}
  </div>;
}

function RewardCellEditor({
  canEdit,
  lifecycle,
  metadata,
  itemId,
  roomIndex,
  weight,
  draft,
  roomTotal,
  locked,
  onDraft,
  onApply,
  onRemove,
  onNormalize,
  onToggleLock,
  onCopyPrevious,
  onShift,
  spreadEnd,
  onSpreadEnd,
  onSpread,
  onScale,
  onMetadata,
}: {
  canEdit: boolean;
  lifecycle?: RewardLifecycle;
  metadata?: RewardMetadata[string];
  itemId: string;
  roomIndex: number;
  weight: string | null;
  draft: string;
  roomTotal: string;
  locked: boolean;
  onDraft: (value: string) => void;
  onApply: (normalize: boolean) => void;
  onRemove: () => void;
  onNormalize: () => void;
  onToggleLock: () => void;
  onCopyPrevious: () => void;
  onShift: (direction: -1 | 1) => void;
  spreadEnd: number;
  onSpreadEnd: (room: number) => void;
  onSpread: () => void;
  onScale: (multiplier: string) => void;
  onMetadata: (patch: RewardMetadata[string]) => void;
}) {
  const stage = rewardStage(lifecycle, roomIndex);
  const weightChanged = validWeight(draft) && (weight === null
    ? !new Decimal(draft).isZero()
    : !new Decimal(draft).equals(weight));
  const needsNormalization = !new Decimal(roomTotal).equals(100);
  return <article className="panel map-cell-editor">
    <div className="cell-editor-heading"><ItemIcon itemId={itemId} size="lg" /><span className={`stage-icon ${stage}`}>{stageSymbol(stage)}</span><div><small>Комната {roomIndex} · {stageLabel(stage)}</small><h2>{itemId || 'Выберите награду'}</h2><p>Сумма комнаты сейчас <b className={new Decimal(roomTotal).equals(100) ? 'sum-ok' : 'sum-error'}>{roomTotal}%</b></p></div></div>
    <label className="weight-editor"><span>Точный процент</span><div><input inputMode="decimal" value={draft} disabled={!canEdit || locked} onChange={(event) => onDraft(event.target.value)} /><b>%</b></div><input type="range" min="0" max="100" step="0.1" value={Math.min(100, Math.max(0, Number(draft) || 0))} disabled={!canEdit || locked} onChange={(event) => onDraft(event.target.value)} /></label>
    <div className="cell-primary-actions"><button className="button primary" disabled={!canEdit || locked || !validWeight(draft) || (!weightChanged && !needsNormalization)} onClick={() => onApply(true)}>{weight === null ? 'Добавить и нормализовать' : 'Изменить + нормализовать'}</button><button className="button secondary" disabled={!canEdit || locked || !weightChanged} onClick={() => onApply(false)}>Оставить временную сумму</button>{weight !== null && <button className="button secondary danger-outline" disabled={!canEdit || locked} onClick={onRemove}>Удалить</button>}</div>
    <div className="cell-tools"><button className={locked ? 'active' : ''} disabled={!canEdit} onClick={onToggleLock}>{locked ? '■ Значение заблокировано' : '□ Заблокировать ячейку'}</button><button disabled={!canEdit || !needsNormalization} onClick={onNormalize}>Нормализовать комнату</button><button disabled={!canEdit || roomIndex <= 1} onClick={onCopyPrevious}>Копировать предыдущую</button><button disabled={!canEdit} onClick={() => onShift(-1)}>← Схема назад</button><button disabled={!canEdit} onClick={() => onShift(1)}>Схема вперёд →</button></div>
    <div className="cell-bulk-tools"><strong>Массовая правка выбранной награды</strong><button disabled={!canEdit} onClick={() => onScale('0.9')}>Все активные −10%</button><button disabled={!canEdit} onClick={() => onScale('1.1')}>Все активные +10%</button><label>Протянуть {draft}% до комнаты <input type="number" min="1" max="46" value={spreadEnd} onChange={(event) => onSpreadEnd(Number(event.target.value))} /></label><button disabled={!canEdit || !validWeight(draft)} onClick={onSpread}>Протянуть и нормализовать</button></div>
    <div className="reward-service-flags"><label><input type="checkbox" checked={metadata?.protected ?? false} onChange={(event) => onMetadata({ protected: event.target.checked })} /> Не удалять автоматически</label><label><input type="checkbox" checked={metadata?.event ?? false} onChange={(event) => onMetadata({ event: event.target.checked })} /> Событийная награда</label><small>Служебные отметки сохраняются в сервисе и не попадают в игровой JSON.</small></div>
  </article>;
}

function RewardHeatmapRow({ lifecycle, known, selectedItem, selectedRoom, lockedCells, onSelect }: {
  lifecycle: RewardLifecycle;
  known: KnownConfigs;
  selectedItem: string;
  selectedRoom: number;
  lockedCells: ReadonlySet<string>;
  onSelect: (itemId: string, roomIndex: number) => void;
}) {
  const price = known.sellItems.find((item) => item.id === lifecycle.itemId)?.sellPrice ?? '0';
  return <tr className={lifecycle.itemId === selectedItem ? 'selected-row' : ''}><th className="reward-name-column"><button onClick={() => onSelect(lifecycle.itemId, selectedRoom)}><ItemIcon itemId={lifecycle.itemId} size="md" /><span><strong>{lifecycle.itemId}</strong><small>{formatExact(price).short} · комнаты {lifecycle.firstRoom ?? '—'}–{lifecycle.lastRoom ?? '—'}</small></span></button></th>{known.rooms.map((room) => {
    const placement = lifecycle.placements.find((item) => item.roomIndex === room.index);
    const weight = placement?.weight ?? '0';
    const stage = rewardStage(lifecycle, room.index);
    const locked = lockedCells.has(cellKey(room.index, lifecycle.itemId));
    const heat = Math.min(1, Number(weight) / 28);
    const style = { '--heat': String(heat) } as CSSProperties;
    return <td className={`${stage} ${room.index === selectedRoom ? 'selected-column' : ''} ${locked ? 'locked' : ''}`} style={style} key={room.index}><button title={`${lifecycle.itemId} · комната ${room.index} · ${weight}% · ${stageLabel(stage)}`} onClick={() => onSelect(lifecycle.itemId, room.index)}><span>{placement ? weight : '—'}</span>{stage !== 'absent' && stage !== 'stable' && <i>{stageSymbol(stage)}</i>}{locked && <em>■</em>}</button></td>;
  })}</tr>;
}

function LifecyclePanel({ lifecycle, known, metadata, onMetadata }: {
  lifecycle: RewardLifecycle;
  known: KnownConfigs;
  metadata?: RewardMetadata[string];
  onMetadata: (patch: RewardMetadata[string]) => void;
}) {
  const values = known.rooms.map((room) => Number(lifecycle.placements.find((placement) => placement.roomIndex === room.index)?.weight ?? 0));
  return <article className="panel lifecycle-panel"><div className="lifecycle-details"><p className="eyebrow">Жизненный цикл награды</p><div className="lifecycle-title"><ItemIcon itemId={lifecycle.itemId} size="xl" /><h2>{lifecycle.itemId}</h2></div><div className="lifecycle-stats"><span><small>Цена</small><strong>{formatExact(lifecycle.sellPrice).short}</strong></span><span><small>Авторанг по цене</small><strong>#{lifecycle.automaticRank}</strong></span><span><small>Первая комната</small><strong>{lifecycle.firstRoom ?? '—'}</strong></span><span><small>Большой шанс</small><strong>{lifecycle.peakRoom ?? '—'} · {lifecycle.maximumWeight}%</strong></span><span><small>Последняя перед 0%</small><strong>{lifecycle.lastRoom ?? '—'}</strong></span><span><small>Длина жизни</small><strong>{lifecycle.activeRoomCount} комн.</strong></span></div><label className="manual-rank"><span>Ручной ранг прогрессии</span><input type="number" min="1" max={known.sellItems.length} value={metadata?.manualRank ?? lifecycle.automaticRank} onChange={(event) => onMetadata({ manualRank: Number(event.target.value) })} /><small>{metadata?.manualRank && metadata.manualRank !== lifecycle.automaticRank ? 'Ручной ранг отличается от порядка цены — это допустимое наблюдение.' : 'Сейчас совпадает с автоматическим рангом по цене.'}</small></label><label className="manual-rank"><span>Служебная группа</span><input value={metadata?.group ?? ''} placeholder="Например: космос, событие" onChange={(event) => onMetadata({ group: event.target.value })} /></label></div><div className="lifecycle-chart"><LineChart labels={known.rooms.map((room) => String(room.index))} xAxisLabel="Номер комнаты" yAxisLabel="Вероятность, %" height={360} series={[{ label: lifecycle.itemId, color: '#6b5ce7', values }]} ariaLabel={`Процент ${lifecycle.itemId} по комнатам`} /></div></article>;
}

function NeighborsView({ known, analysis, selectedRoom, selectedItem, onRoom, onCell }: {
  known: KnownConfigs;
  analysis: ReturnType<typeof analyzeRewardProgression>;
  selectedRoom: number;
  selectedItem: string;
  onRoom: (room: number) => void;
  onCell: (itemId: string, roomIndex: number) => void;
}) {
  const rooms = known.rooms.filter((room) => room.index >= selectedRoom - 2 && room.index <= selectedRoom + 5);
  const items = Array.from(new Set(rooms.flatMap((room) => known.roomDrops.find((dropRoom) => dropRoom.index === room.index)?.drops.map((drop) => drop.itemId) ?? [])))
    .sort((left, right) => (analysis.ranks.get(left) ?? 0) - (analysis.ranks.get(right) ?? 0));
  return <article className="panel neighbor-panel"><header><div><p className="eyebrow">Сравнение соседних комнат</p><h2>Комната {selectedRoom} и следующие</h2><p>Две предыдущие, выбранная и пять следующих комнат. Строки наград выровнены для быстрого сравнения.</p></div><label>Центральная комната<select value={selectedRoom} onChange={(event) => onRoom(Number(event.target.value))}>{known.rooms.map((room) => <option key={room.index} value={room.index}>{room.index}</option>)}</select></label></header><div className="neighbor-scroll"><table className="neighbor-table"><thead><tr><th>Награда · цена</th>{rooms.map((room) => { const metric = analysis.metricByRoom.get(room.index); return <th className={room.index === selectedRoom ? 'current' : ''} key={room.index}><strong>Комната {room.index}</strong><small>{metric?.activeCount} типов · +{metric?.newCount} новых · {metric?.lastCount} последних</small><span>Средняя {formatExact(metric?.expectedItemPrice ?? '0').short}</span></th>; })}</tr></thead><tbody>{items.map((itemId) => { const lifecycle = analysis.lifecycleByItem.get(itemId); const price = known.sellItems.find((item) => item.id === itemId)?.sellPrice ?? '0'; return <tr className={itemId === selectedItem ? 'selected' : ''} key={itemId}><th><button onClick={() => onCell(itemId, selectedRoom)}><ItemIcon itemId={itemId} size="sm" /><span><strong>{itemId}</strong><small>#{analysis.ranks.get(itemId)} · {formatExact(price).short}</small></span></button></th>{rooms.map((room) => { const current = known.roomDrops.find((dropRoom) => dropRoom.index === room.index)?.drops.find((drop) => drop.itemId === itemId); const previous = known.roomDrops.find((dropRoom) => dropRoom.index === room.index - 1)?.drops.find((drop) => drop.itemId === itemId); const delta = new Decimal(current?.weight ?? 0).minus(previous?.weight ?? 0); const stage = rewardStage(lifecycle, room.index); const roomAttemptCount = itemsForRoom(room.index, known.sellSettings); return <td className={`${stage} ${room.index === selectedRoom ? 'current' : ''}`} key={room.index}><button onClick={() => onCell(itemId, room.index)}>{current ? <><strong>{current.weight}%</strong><small>{delta.isZero() ? '0' : `${delta.isPositive() ? '+' : ''}${delta.toString()} п.п.`}</small><span>{stageSymbol(stage)} {stageLabel(stage)}</span><small className="attempt-chance">≥1 из {roomAttemptCount}: {probabilityAtLeastOnce(current.weight, roomAttemptCount)}%</small></> : <i>{stage === 'removed' ? '0% · удалена' : '—'}</i>}</button></td>; })}</tr>; })}</tbody></table></div><footer className="mechanics-footnote">Игровой расчёт 1−(1−p)ⁿ: n=7 в нечётных комнатах и n=8 в чётных. Каждый столбец использует собственное точное n.</footer></article>;
}

function RewardAnalyticsView({ known, analysis, selectedRoom, selectedItem, onRoom }: {
  known: KnownConfigs;
  analysis: ReturnType<typeof analyzeRewardProgression>;
  selectedRoom: number;
  selectedItem: string;
  onRoom: (room: number) => void;
}) {
  const [comparedItems, setComparedItems] = useState<string[]>([]);
  const comparisonItems = Array.from(new Set([selectedItem, ...comparedItems])).filter(Boolean).slice(0, 4);
  const labels = known.rooms.map((room) => String(room.index));
  const colors = ['#6658e8', '#12a47c', '#e58b2b', '#d05475'];
  const priceByItem = new Map(known.sellItems.map((item) => [item.id, new Decimal(item.sellPrice)]));
  const sortedItems = [...known.sellItems].sort((left, right) => new Decimal(left.sellPrice).comparedTo(right.sellPrice));
  const groupNames = ['Базовые 25%', 'Развитие 25%', 'Сильные 25%', 'Топ 25%'];
  const groupColors = ['#8d84dc', '#4d86d9', '#13a47b', '#e58b2b'];
  const groupByItem = new Map(sortedItems.map((item, index) => [item.id, Math.min(3, Math.floor(index * 4 / Math.max(sortedItems.length, 1)))]));
  const selectedRoomDrops = [...(known.roomDrops.find((room) => room.index === selectedRoom)?.drops ?? [])]
    .sort((left, right) => new Decimal(right.weight).comparedTo(left.weight));
  const newRewardChance = known.roomDrops.map((room) => {
    const combinedWeight = room.drops.reduce((sum, drop) => (
      analysis.lifecycleByItem.get(drop.itemId)?.firstRoom === room.index ? sum.plus(drop.weight) : sum
    ), new Decimal(0));
    return probabilityAtLeastOnce(combinedWeight.toString(), itemsForRoom(room.index, known.sellSettings));
  });
  const comparisonSeries = comparisonItems.map((itemId, index) => ({
    label: itemId,
    color: colors[index],
    values: known.rooms.map((room) => Number(known.roomDrops.find((dropRoom) => dropRoom.index === room.index)?.drops.find((drop) => drop.itemId === itemId)?.weight ?? 0)),
  }));
  const groupSeries = groupNames.map((name, groupIndex) => ({
    label: name,
    color: groupColors[groupIndex],
    values: known.roomDrops.map((room) => room.drops.reduce((sum, drop) => groupByItem.get(drop.itemId) === groupIndex ? sum + Number(drop.weight) : sum, 0)),
  }));

  return <section className="reward-analytics">
    <article className="panel analytics-controls"><div><p className="eyebrow">Сводная аналитика RoomDrops</p><h2>Графики прогрессии наград</h2><p>Полная картина без 75 наложенных линий: выбранные награды и агрегированные группы.</p></div><label>Комната<select value={selectedRoom} onChange={(event) => onRoom(Number(event.target.value))}>{known.rooms.map((room) => <option key={room.index} value={room.index}>{room.index}</option>)}</select></label><label>Добавить награду в сравнение<select value="" onChange={(event) => { if (event.target.value) setComparedItems((items) => Array.from(new Set([...items, event.target.value])).slice(-3)); }}><option value="">Выберите…</option>{analysis.lifecycles.filter((lifecycle) => !comparisonItems.includes(lifecycle.itemId)).map((lifecycle) => <option key={lifecycle.itemId} value={lifecycle.itemId}>#{lifecycle.automaticRank} · {lifecycle.itemId}</option>)}</select></label><div className="comparison-chips">{comparisonItems.map((itemId, index) => <button style={{ '--chip': colors[index] } as CSSProperties} disabled={itemId === selectedItem} onClick={() => setComparedItems((items) => items.filter((item) => item !== itemId))} key={itemId}><ItemIcon itemId={itemId} size="xs" />{itemId}{itemId !== selectedItem && ' ×'}</button>)}</div></article>

    <div className="analytics-grid">
      <AnalyticsChart title="Выбранные награды" note="До четырёх линий; основная награда выбирается на тепловой карте."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Вероятность, %" height={330} series={comparisonSeries} ariaLabel="Сравнение выбранных наград" /></AnalyticsChart>
      <article className="panel analytics-card room-composition"><header><h3>Состав комнаты {selectedRoom}</h3><p>Точные доли активных наград.</p></header><div>{selectedRoomDrops.map((drop) => <span key={drop.itemId}><ItemIcon itemId={drop.itemId} size="sm" /><label><b>{drop.itemId}</b><small>{formatExact(priceByItem.get(drop.itemId)?.toString() ?? '0').short}</small></label><i><em style={{ width: `${Math.min(100, Number(drop.weight))}%` }} /></i><strong>{drop.weight}%</strong></span>)}</div></article>
      <AnalyticsChart title="Группы ценности" note="Награды разбиты на четыре равные группы по цене продажи."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Доля группы, %" height={330} series={groupSeries} ariaLabel="Состав выпадения по группам ценности" /></AnalyticsChart>
      <AnalyticsChart title="Ожидаемая цена предмета" note="Σ(вес × цена); подтверждённый расчёт по RoomDrops и SellItems."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Ожидаемая цена" height={330} series={[{ label: 'Ожидаемая цена', color: '#12a47c', values: analysis.metrics.map((metric) => Number(metric.expectedItemPrice) || 0) }]} ariaLabel="Ожидаемая цена награды по комнатам" /></AnalyticsChart>
      <AnalyticsChart title="HP и ожидаемая награда" note="Обе величины показаны в log₁₀, чтобы сравнить темп роста."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Значение · log₁₀" height={330} series={[{ label: 'HP блока', color: '#6658e8', values: known.rooms.map((room) => safeLog10(room.blockMaxHP)) }, { label: 'Ожидаемая награда', color: '#12a47c', values: analysis.metrics.map((metric) => safeLog10(metric.expectedItemPrice)) }]} ariaLabel="Связанные графики HP и ожидаемой награды" /></AnalyticsChart>
      <AnalyticsChart title="Шанс увидеть новую награду" note="Хотя бы один раз: 7 бросков в нечётных комнатах и 8 в чётных."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Шанс, %" height={330} series={[{ label: '≥1 из 7/8', color: '#e58b2b', values: newRewardChance }]} ariaLabel="Шанс увидеть новую награду" /></AnalyticsChart>
      <AnalyticsChart title="Активные, новые и последние" note="Последние — предметы в комнате непосредственно перед исчезновением."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Количество" height={330} series={[{ label: 'Активные', color: '#6658e8', values: analysis.metrics.map((metric) => metric.activeCount) }, { label: 'Новые', color: '#12a47c', values: analysis.metrics.map((metric) => metric.newCount) }, { label: 'Последние', color: '#d05475', values: analysis.metrics.map((metric) => metric.lastCount) }]} ariaLabel="Количество активных новых и последних наград" /></AnalyticsChart>
      <AnalyticsChart title="Доля устаревших предметов" note="Цена ниже 20% ожидаемой цены предмета выбранной комнаты."><LineChart labels={labels} xAxisLabel="Номер комнаты" yAxisLabel="Устаревшая доля, %" height={330} series={[{ label: 'Устаревшие', color: '#d05475', values: analysis.metrics.map((metric) => Number(metric.staleWeight)) }]} ariaLabel="Доля устаревших наград" /></AnalyticsChart>
    </div>
  </section>;
}

function AnalyticsChart({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <article className="panel analytics-card"><header><h3>{title}</h3><p>{note}</p></header>{children}</article>;
}

function RewardCatalog({ known, analysis, commitNumber, onSelect }: {
  known: KnownConfigs;
  analysis: ReturnType<typeof analyzeRewardProgression>;
  commitNumber: (config: string, pointer: string, value: string) => void;
  onSelect: (itemId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'rank' | 'price-asc' | 'price-desc' | 'name'>('rank');
  const rows = analysis.lifecycles.filter((item) => !query.trim() || item.itemId.toLowerCase().includes(query.toLowerCase())).sort((left, right) => {
    if (sort === 'price-asc') return new Decimal(left.sellPrice).comparedTo(right.sellPrice);
    if (sort === 'price-desc') return new Decimal(right.sellPrice).comparedTo(left.sellPrice);
    if (sort === 'name') return left.itemId.localeCompare(right.itemId);
    return left.automaticRank - right.automaticRank;
  });
  return <article className="panel editor-panel rewards-catalog"><div className="panel-heading"><div><h2>Все награды и стоимости</h2><p>{rows.length} из {known.sellItems.length} · цена редактируется точно</p></div></div><div className="rewards-toolbar"><label className="reward-search"><span>Поиск</span><input type="search" value={query} placeholder="Название награды" onChange={(event) => setQuery(event.target.value)} /></label><label className="reward-sort"><span>Порядок</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="rank">По прогрессии</option><option value="price-asc">Сначала дешёвые</option><option value="price-desc">Сначала дорогие</option><option value="name">По названию</option></select></label></div><div className="table-scroll rewards-scroll"><table className="data-table rewards-table"><thead><tr><th>Ранг</th><th>Награда</th><th>Цена продажи</th><th>Коротко</th><th>Первая</th><th>Большой шанс</th><th>Последняя перед 0%</th><th>Комнат жизни</th></tr></thead><tbody>{rows.map((row) => { const itemIndex = known.sellItems.findIndex((item) => item.id === row.itemId); return <tr key={row.itemId}><td><strong className="reward-number">{row.automaticRank}</strong></td><td><button className="catalog-item-link" onClick={() => onSelect(row.itemId)}><ItemIcon itemId={row.itemId} size="md" /><span><strong>{row.itemId}</strong><small>Открыть на карте</small></span></button></td><td><InlineExactInput label={`Цена награды ${row.automaticRank} ${row.itemId}`} value={row.sellPrice} onCommit={(value) => commitNumber('SellItems', `$/items/${itemIndex}/sellPrice`, value)} /></td><td>{formatExact(row.sellPrice).short}</td><td>{row.firstRoom ?? '—'}</td><td>{row.peakRoom ?? '—'} · {row.maximumWeight}%</td><td>{row.lastRoom ?? '—'}</td><td>{row.activeRoomCount}</td></tr>; })}</tbody></table></div></article>;
}

function GeneratorView({ settings, setSettings, excludedRoomsText, setExcludedRoomsText, canGenerate, lockedCount, protectedCount, onPreview }: {
  settings: RewardGeneratorSettings;
  setSettings: (settings: RewardGeneratorSettings) => void;
  excludedRoomsText: string;
  setExcludedRoomsText: (value: string) => void;
  canGenerate: boolean;
  lockedCount: number;
  protectedCount: number;
  onPreview: () => void;
}) {
  return <section className="generator-layout">
    <article className="panel generator-settings">
      <div className="panel-heading"><div><h2>Расставить награды автоматически</h2><p>Одинаковые настройки дают одинаковый результат. Плохая схема не применяется автоматически.</p></div></div>
      <div className="template-cards">{Object.values(lifecycleTemplates).map((template) => <button
        className={settings.templateId === template.id ? 'active' : ''}
        onClick={() => setSettings({ ...settings, templateId: template.id, minimumJackpotPercent: template.minimumPercent, highChanceHoldRooms: template.highRoomCount, minimumReplacementPercent: template.minimumReplacementPercent })}
        key={template.id}
      ><strong>{template.name}</strong><span>{template.description}</span><small>{template.curve.join(' → ')} → 0 · высокий шанс {template.highRoomCount} комн. · сумма кривой {template.curve.reduce((sum, value) => sum + value, 0)}%</small></button>)}</div>
      <div className="generator-grid">
        <GeneratorField label="От комнаты"><input type="number" min="1" max="46" value={settings.roomStart} onChange={(event) => setSettings({ ...settings, roomStart: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="До комнаты"><input type="number" min="1" max="46" value={settings.roomEnd} onChange={(event) => setSettings({ ...settings, roomEnd: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Максимум активных типов"><input type="number" min="1" max="30" value={settings.maximumActive} onChange={(event) => setSettings({ ...settings, maximumActive: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Новых наград за появление"><input type="number" min="1" max="5" value={settings.newRewardsPerRoom} onChange={(event) => setSettings({ ...settings, newRewardsPerRoom: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Интервал появления, комнат"><input type="number" min="1" max="10" value={settings.newRewardEvery} onChange={(event) => setSettings({ ...settings, newRewardEvery: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Минимум новой награде, %"><input type="number" min="1" max="20" step="1" value={settings.minimumJackpotPercent} onChange={(event) => setSettings({ ...settings, minimumJackpotPercent: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Комнат с большим шансом"><input type="number" min="1" max="6" step="1" value={settings.highChanceHoldRooms ?? 1} onChange={(event) => setSettings({ ...settings, highChanceHoldRooms: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Минимум сильных замен"><input type="number" min="1" max="8" step="1" value={settings.minimumReplacementCount ?? 1} onChange={(event) => setSettings({ ...settings, minimumReplacementCount: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Минимум сильной замены, п.п."><input type="number" min="1" max="100" step="1" value={settings.minimumReplacementPercent ?? 29} onChange={(event) => setSettings({ ...settings, minimumReplacementPercent: Number(event.target.value) })} /></GeneratorField>
        <GeneratorField label="Точность процентов"><select value={settings.precision} onChange={(event) => setSettings({ ...settings, precision: event.target.value })}><option value="1">Целые проценты</option><option value="0.1">До 0,1%</option><option value="0.01">До 0,01%</option></select></GeneratorField>
        <GeneratorField label="Исключить специальные комнаты"><input placeholder="Например: 10, 20, 30" value={excludedRoomsText} onChange={(event) => setExcludedRoomsText(event.target.value)} /></GeneratorField>
      </div>
      <div className="generator-safety"><span>■ {lockedCount} заблокированных ячеек</span><span>◆ {protectedCount} наград «не удалять»</span><span>✓ Каждой новой награде не меньше {settings.minimumJackpotPercent}%</span><span>✓ Только черновик</span><span>✓ Сумма комнаты ровно 100%</span></div>
      <button className="button primary generator-run" disabled={!canGenerate} onClick={onPreview}>Сформировать предварительный вариант</button>
    </article>
    <article className="panel generator-explanation"><h2>Что сделает генератор</h2><ol><li>Отсортирует награды по цене или ручному рангу.</li><li>Для стандарта использует точную кривую 1–2–3–5–8–12–17–23–29%.</li><li>Не даст новой награде округлиться до 0%.</li><li>Если лимит типов не вмещает полные циклы, попросит разнести появления, а не создаст разрывы.</li><li>После большого шанса удалит предмет сразу в 0% только при достаточной более сильной замене.</li><li>Не допустит падения ожидаемой ценности и шанса хорошей награды при удалении.</li><li>Сохранит заблокированные и защищённые значения.</li><li>Покажет точное сравнение до применения.</li></ol><div className="generator-warning"><strong>Никакой автоматической публикации</strong><p>Результат сначала показывается в предпросмотре. После принятия он остаётся черновиком до сохранения отдельной версии.</p></div></article>
  </section>;
}

function PreviewPanel({ title, before, after, known, selectedRooms, onToggleRoom, onCancel, onApply, canEdit }: {
  title: string;
  before: RoomDrop[];
  after: RoomDrop[];
  known: KnownConfigs;
  selectedRooms: ReadonlySet<number>;
  onToggleRoom: (room: number) => void;
  onCancel: () => void;
  onApply: () => void;
  canEdit: boolean;
}) {
  const beforeKnown = { ...known, roomDrops: before };
  const afterKnown = { ...known, roomDrops: after };
  const beforeAnalysis = analyzeRewardProgression(beforeKnown);
  const afterAnalysis = analyzeRewardProgression(afterKnown);
  const beforeWarnings = buildRewardSuggestions(beforeKnown).filter((suggestion) => suggestion.severity === 'warning');
  const afterWarnings = buildRewardSuggestions(afterKnown).filter((suggestion) => suggestion.severity === 'warning');
  const changedRooms = after.filter((room) => {
    const original = before.find((item) => item.index === room.index);
    return original ? countRewardChanges([original], [room]) > 0 : true;
  });
  const changedCells = countRewardChanges(before, after);
  const added = countPresenceChanges(before, after, 'added');
  const removed = countPresenceChanges(before, after, 'removed');
  return <div className="modal-backdrop reward-preview-backdrop"><section className="reward-preview"><header><div><p className="eyebrow">До применения</p><h2>{title}</h2><p>Матрица «было / станет». Выберите комнаты, которые нужно принять; остальные останутся без изменений.</p></div><button onClick={onCancel}>×</button></header><div className="preview-metrics"><span><small>Изменено ячеек</small><strong>{changedCells}</strong></span><span><small>Добавлено связей</small><strong>+{added}</strong></span><span><small>Удалено связей</small><strong>−{removed}</strong></span><span><small>Предупреждения</small><strong>{beforeWarnings.length} → {afterWarnings.length}</strong></span><span><small>Выбрано комнат</small><strong>{selectedRooms.size}</strong></span></div><div className="preview-chart"><LineChart labels={known.rooms.map((room) => String(room.index))} xAxisLabel="Номер комнаты" yAxisLabel="Ожидаемая цена" height={250} series={[{ label: 'Было', color: '#8c83db', dash: [8, 6], values: beforeAnalysis.metrics.map((metric) => Number(metric.expectedItemPrice) || 0) }, { label: 'Станет', color: '#12a47c', values: afterAnalysis.metrics.map((metric) => Number(metric.expectedItemPrice) || 0) }]} ariaLabel="Ожидаемая цена наград до и после" /></div><div className="preview-room-list">{changedRooms.map((room) => { const originalRoom = before.find((item) => item.index === room.index); const beforeMetric = beforeAnalysis.metricByRoom.get(room.index); const afterMetric = afterAnalysis.metricByRoom.get(room.index); const roomChanges = countRewardChanges(originalRoom ? [originalRoom] : [], [room]); const beforeRoomWarnings = beforeWarnings.filter((warning) => warning.rooms.includes(room.index)).length; const afterRoomWarnings = afterWarnings.filter((warning) => warning.rooms.includes(room.index)).length; const exactChanges = describeRoomChanges(originalRoom, room); return <label className={selectedRooms.has(room.index) ? 'selected' : ''} key={room.index}><input type="checkbox" checked={selectedRooms.has(room.index)} onChange={() => onToggleRoom(room.index)} /><strong>Комната {room.index}</strong><span>{roomChanges} изм.</span><small>Средняя награда: {formatExact(beforeMetric?.expectedItemPrice ?? '0').short} → <b>{formatExact(afterMetric?.expectedItemPrice ?? '0').short}</b></small><small>Слабая доля: {beforeMetric?.staleWeight ?? 0}% → {afterMetric?.staleWeight ?? 0}% · джекпот: {beforeMetric?.jackpotIndex ?? 0} → {afterMetric?.jackpotIndex ?? 0}</small><small>Предупреждения: {beforeRoomWarnings} → {afterRoomWarnings}</small><small className="preview-exact-changes">{exactChanges.join(' · ')}{roomChanges > exactChanges.length ? ` · ещё ${roomChanges - exactChanges.length}` : ''}</small></label>; })}</div><footer><button className="button secondary" onClick={onCancel}>Отменить</button><button className="button primary" disabled={!canEdit || selectedRooms.size === 0} onClick={onApply}>Применить выбранные комнаты в черновик</button></footer></section></div>;
}

function InlineExactInput({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  return <input className="inline-exact-input" aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (validWeight(draft, false)) onCommit(draft); else setDraft(value); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}

function GeneratorField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="generator-field"><span>{label}</span>{children}</label>;
}

function stageLabel(stage: RewardStage) {
  return ({ new: 'Новая', rising: 'Растёт', high: 'Большой шанс', falling: 'Снижена в текущей схеме', last: 'Последняя перед удалением', removed: 'Удалена в 0%', stable: 'Без изменения', absent: 'Не выпадает' } as Record<RewardStage, string>)[stage];
}

function stageSymbol(stage: RewardStage) {
  return ({ new: 'Н', rising: '▲', high: 'Б', falling: '▼', last: 'К', removed: '0', stable: '•', absent: '—' } as Record<RewardStage, string>)[stage];
}

function validWeight(value: string, capAtHundred = true) {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && !parsed.isNegative() && (!capAtHundred || parsed.lessThanOrEqualTo(100));
  } catch {
    return false;
  }
}

function safeLog10(value: string) {
  const numeric = Number(value);
  return numeric > 0 && Number.isFinite(numeric) ? Math.log10(numeric) : 0;
}

function parseRoomList(value: string) {
  if (!value.trim()) return [];
  const rooms = value.split(/[ ,;]+/).filter(Boolean).map(Number);
  if (rooms.some((room) => !Number.isInteger(room) || room < 1 || room > 46)) throw new Error('Исключённые комнаты укажите числами от 1 до 46 через запятую.');
  return Array.from(new Set(rooms));
}

function describeRoomChanges(before: RoomDrop | undefined, after: RoomDrop) {
  const beforeWeights = new Map(before?.drops.map((drop) => [drop.itemId, drop.weight]) ?? []);
  const afterWeights = new Map(after.drops.map((drop) => [drop.itemId, drop.weight]));
  return Array.from(new Set([...beforeWeights.keys(), ...afterWeights.keys()]))
    .filter((itemId) => beforeWeights.get(itemId) !== afterWeights.get(itemId))
    .slice(0, 5)
    .map((itemId) => `${itemId}: ${beforeWeights.get(itemId) ?? '0'}% → ${afterWeights.get(itemId) ?? '0'}%`);
}

function countPresenceChanges(before: RoomDrop[], after: RoomDrop[], type: 'added' | 'removed') {
  const beforeKeys = new Set(before.flatMap((room) => room.drops.map((drop) => cellKey(room.index, drop.itemId))));
  const afterKeys = new Set(after.flatMap((room) => room.drops.map((drop) => cellKey(room.index, drop.itemId))));
  return type === 'added'
    ? [...afterKeys].filter((key) => !beforeKeys.has(key)).length
    : [...beforeKeys].filter((key) => !afterKeys.has(key)).length;
}
