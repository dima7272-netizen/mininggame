'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client Link runtime fails in the hosted build. */

import { useState } from 'react';
import { GameBrandIcon } from '@/components/game-brand-icon';

export function InviteClient({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const accept = async () => {
    setState('loading');
    const response = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = await response.json() as { error?: string; role?: string; alreadyMember?: boolean };
    if (!response.ok) {
      setState('error');
      setMessage(body.error ?? 'Не удалось принять приглашение.');
      return;
    }
    setState('done');
    setMessage(body.alreadyMember
      ? 'Доступ уже был выдан. Можно открыть баланс-центр.'
      : `Доступ выдан. Роль: ${body.role ?? 'участник'}.`);
  };

  return (
    <main className="invite-page">
      <section className="invite-card">
        <GameBrandIcon priority />
        <p className="eyebrow">Dig Get Stronger</p>
        <h1>Приглашение в баланс-центр</h1>
        <p>Подтвердите подключение к команде. Роль и права назначены владельцем приглашения.</p>
        {message && <div className={`invite-message ${state}`}>{message}</div>}
        {state === 'done' ? (
          <a className="button primary invite-action" href="/">Открыть сервис</a>
        ) : (
          <button className="button primary invite-action" disabled={state === 'loading'} onClick={accept}>
            {state === 'loading' ? 'Проверяем…' : 'Принять приглашение'}
          </button>
        )}
      </section>
    </main>
  );
}
