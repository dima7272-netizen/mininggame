'use client';

import { useState, type FormEvent } from 'react';
import type { AuthPageState } from '@/lib/app-auth';
import { GameBrandIcon } from '@/components/game-brand-icon';

type Mode = 'login' | 'register';

export function AuthForm({
  chatGPTSignInUrl,
  inviteToken,
  returnTo,
  state,
}: {
  chatGPTSignInUrl: string;
  inviteToken?: string;
  returnTo: string;
  state: AuthPageState;
}) {
  const [mode, setMode] = useState<Mode>(state.registrationAllowed ? 'register' : 'login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(state.invitationMessage);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') ?? '');
    if (mode === 'register' && password !== String(values.get('passwordConfirm') ?? '')) {
      setError('Пароли не совпадают.');
      setBusy(false);
      return;
    }

    try {
      const response = await fetch(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: values.get('displayName'),
          email: values.get('email'),
          password,
          inviteToken: mode === 'register' ? inviteToken : undefined,
          returnTo,
        }),
      });
      const body = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) throw new Error(body.error ?? 'Операция не выполнена.');
      location.assign(body.redirectTo ?? '/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Операция не выполнена.');
      setBusy(false);
    }
  }

  const registrationTitle = state.bootstrapRegistration
    ? 'Создайте аккаунт владельца'
    : 'Присоединитесь к команде';

  return (
    <main className="auth-page">
      <section className="auth-showcase">
        <div className="auth-brand"><GameBrandIcon priority /><div><strong>Dig Get Stronger</strong><small>Баланс-центр</small></div></div>
        <div className="auth-intro">
          <p className="eyebrow">Настройка игры</p>
          <h1>Вся команда работает с одним актуальным балансом</h1>
          <p>Комнаты, награды, кирки, версии и публикации — в защищённом рабочем пространстве.</p>
          <ul>
            <li><span>✓</span> Постоянная история изменений и откаты</li>
            <li><span>✓</span> Отдельные роли и права для команды</li>
            <li><span>✓</span> Вход через ChatGPT или по email и паролю</li>
          </ul>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <header>
            <p className="eyebrow">Добро пожаловать</p>
            <h2>{mode === 'register' ? registrationTitle : 'Вход в баланс-центр'}</h2>
            <p>{mode === 'register'
              ? state.bootstrapRegistration
                ? 'Это первый аккаунт. Он получит права владельца.'
                : 'Приглашение определит вашу роль и доступные разделы.'
              : 'Используйте email и пароль, созданные в этом сервисе.'}</p>
          </header>

          <div className="auth-tabs" role="tablist" aria-label="Способ входа">
            <button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(null); }} type="button">Войти</button>
            <button
              className={mode === 'register' ? 'selected' : ''}
              disabled={!state.registrationAllowed}
              onClick={() => { setMode('register'); setError(state.invitationMessage); }}
              type="button"
            >Регистрация</button>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' && <label><span>Ваше имя</span><input autoComplete="name" name="displayName" placeholder="Например, Дмитрий" required minLength={2} maxLength={80} /></label>}
            <label><span>Email</span><input autoComplete="email" inputMode="email" name="email" placeholder="name@company.com" required type="email" /></label>
            <label><span>Пароль</span><input autoComplete={mode === 'register' ? 'new-password' : 'current-password'} name="password" placeholder={mode === 'register' ? 'Не меньше 12 символов' : 'Ваш пароль'} required minLength={mode === 'register' ? 12 : 1} maxLength={128} type="password" /></label>
            {mode === 'register' && <label><span>Повторите пароль</span><input autoComplete="new-password" name="passwordConfirm" placeholder="Повторите пароль" required minLength={12} maxLength={128} type="password" /></label>}
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="button primary auth-submit" disabled={busy || (mode === 'register' && !state.registrationAllowed)} type="submit">
              {busy ? 'Подождите…' : mode === 'register' ? 'Создать аккаунт' : 'Войти в сервис'}
            </button>
          </form>

          <div className="auth-divider"><span>или</span></div>
          <a className="chatgpt-login-button" href={chatGPTSignInUrl}>
            <span className="chatgpt-login-mark" aria-hidden="true">✦</span>
            <span><strong>Войти через ChatGPT</strong><small>Вернуться в прежнюю учётную запись</small></span>
          </a>

          {!state.registrationAllowed && <p className="auth-invite-note">Новый участник регистрируется только по ссылке из раздела «Команда и права».</p>}
          <footer>Для входа через ChatGPT пароль сервису не передаётся. Для обычной регистрации хранится только защищённый хеш пароля.</footer>
        </div>
      </section>
    </main>
  );
}
