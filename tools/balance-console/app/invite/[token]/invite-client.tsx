'use client';

import { useState } from 'react';
import Link from 'next/link';

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
        <div className="brand-mark">D</div>
        <p className="eyebrow">Dig Get Stronger</p>
        <h1>Приглашение в баланс-центр</h1>
        <p>Войдите в Codex и подтвердите доступ. Открытая регистрация отключена.</p>
        {message && <div className={`invite-message ${state}`}>{message}</div>}
        {state === 'done' ? (
          <Link className="button primary invite-action" href="/">Открыть сервис</Link>
        ) : (
          <button className="button primary invite-action" disabled={state === 'loading'} onClick={accept}>
            {state === 'loading' ? 'Проверяем…' : 'Принять приглашение'}
          </button>
        )}
      </section>
    </main>
  );
}
