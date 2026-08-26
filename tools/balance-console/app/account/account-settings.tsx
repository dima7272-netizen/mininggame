'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { AccountState } from '@/lib/account';

const roleLabels: Record<string, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  balancer: 'Балансировщик',
  tester: 'Тестировщик',
  prod_publisher: 'Публикатор PROD',
  observer: 'Наблюдатель',
};

export function AccountSettings({
  initialState,
  chatGPTSignInUrl,
  chatGPTAvailable,
  connectRequested,
}: {
  initialState: AccountState;
  chatGPTSignInUrl: string;
  chatGPTAvailable: boolean;
  connectRequested: boolean;
}) {
  const [account, setAccount] = useState(initialState);
  const [displayName, setDisplayName] = useState(initialState.user.displayName);
  const [email, setEmail] = useState(initialState.user.email);
  const [profilePassword, setProfilePassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectStarted = useRef(false);

  async function apiAction(action: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      const body = await response.json() as { account?: AccountState; error?: string };
      if (!response.ok || !body.account) throw new Error(body.error ?? 'Операция не выполнена.');
      setAccount(body.account);
      setDisplayName(body.account.user.displayName);
      setEmail(body.account.user.email);
      return body.account;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Операция не выполнена.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!connectRequested || !chatGPTAvailable || account.chatGPT.connected || connectStarted.current) return;
    connectStarted.current = true;
    void apiAction({ action: 'connect_chatgpt' }, 'chatgpt').then((result) => {
      if (result) {
        setMessage('Вход через ChatGPT подключён к вашей карточке.');
        history.replaceState(null, '', '/account');
      }
    });
  }, [account.chatGPT.connected, chatGPTAvailable, connectRequested]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await apiAction({
      action: 'update_profile',
      displayName,
      email,
      currentPassword: profilePassword || undefined,
    }, 'profile');
    if (result) {
      setProfilePassword('');
      setMessage('Личные данные сохранены.');
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== passwordConfirm) {
      setError('Новый пароль и его повтор не совпадают.');
      return;
    }
    const wasConnected = account.hasPassword;
    const result = await apiAction({
      action: 'change_password',
      currentPassword: currentPassword || undefined,
      newPassword,
    }, 'password');
    if (result) {
      setCurrentPassword('');
      setNewPassword('');
      setPasswordConfirm('');
      setMessage(wasConnected ? 'Пароль изменён. Остальные парольные сессии завершены.' : 'Вход по email и паролю подключён.');
    }
  }

  async function connectChatGPT() {
    const result = await apiAction({ action: 'connect_chatgpt' }, 'chatgpt');
    if (result) setMessage('Вход через ChatGPT подключён к вашей карточке.');
  }

  async function logout() {
    setBusy('logout');
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    const body = await response.json() as { redirectTo?: string };
    location.assign(body.redirectTo ?? '/login');
  }

  const initials = account.user.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <main className="account-page">
      <header className="account-topbar">
        <Link className="account-back" href="/">← Вернуться в баланс-центр</Link>
        <div className="auth-brand"><span className="brand-mark">D</span><div><strong>Dig Get Stronger</strong><small>Мой аккаунт</small></div></div>
        <button className="button secondary" disabled={busy === 'logout'} onClick={() => void logout()}>Выйти</button>
      </header>
      <div className="account-layout">
        <aside className="account-summary-card">
          <div className="account-avatar">{initials}</div>
          <p className="eyebrow">Ваша карточка</p>
          <h1>{account.user.displayName}</h1>
          <p>{account.user.email}</p>
          <span className="account-role">{roleLabels[account.role] ?? account.role}</span>
          <dl className="account-method-summary">
            <div><dt>Способов входа</dt><dd>{Number(account.hasPassword) + Number(account.chatGPT.connected)}</dd></div>
            <div><dt>Рабочее пространство</dt><dd>Dig Get Stronger</dd></div>
          </dl>
        </aside>
        <section className="account-content">
          <header className="account-heading">
            <p className="eyebrow">Настройки аккаунта</p>
            <h2>Профиль и способы входа</h2>
            <p>Изменения сохраняются только в вашей карточке и не затрагивают игровые конфиги.</p>
          </header>
          {(message || error) && <button className={error ? 'account-feedback error' : 'account-feedback'} onClick={() => { setMessage(null); setError(null); }}>{error ?? message}<span>×</span></button>}

          <article className="account-section-card">
            <div className="account-section-title"><span>01</span><div><h3>Личные данные</h3><p>Имя и основной email аккаунта</p></div></div>
            <form className="account-form" onSubmit={saveProfile}>
              <label><span>Имя</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={80} required /></label>
              <label><span>Email для входа</span><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" inputMode="email" maxLength={254} required /></label>
              {account.hasPassword && email.trim().toLowerCase() !== account.user.email.toLowerCase() && <label className="account-form-wide"><span>Текущий пароль для смены email</span><input value={profilePassword} onChange={(event) => setProfilePassword(event.target.value)} type="password" autoComplete="current-password" required /></label>}
              <div className="account-form-actions"><small>Этот email используется для входа по паролю и уведомлений команды.</small><button className="button primary" disabled={busy === 'profile'} type="submit">{busy === 'profile' ? 'Сохраняю…' : 'Сохранить профиль'}</button></div>
            </form>
          </article>

          <article className="account-section-card">
            <div className="account-section-title"><span>02</span><div><h3>Способы входа</h3><p>Подключите несколько вариантов и используйте любой из них</p></div></div>
            <div className="login-method-list">
              <div className={account.chatGPT.connected ? 'login-method connected' : 'login-method'}>
                <i>✦</i><div><strong>ChatGPT</strong><small>{account.chatGPT.email ?? 'Вернуться в существующую учётную запись'}</small></div>
                {account.chatGPT.connected ? <b>Подключено</b> : chatGPTAvailable
                  ? <button disabled={busy === 'chatgpt'} onClick={() => void connectChatGPT()}>Подключить</button>
                  : <a href={chatGPTSignInUrl}>Подключить</a>}
              </div>
              <div className={account.hasPassword ? 'login-method connected' : 'login-method'}>
                <i>@</i><div><strong>Email и пароль</strong><small>{account.hasPassword ? account.user.email : 'Создайте пароль ниже'}</small></div><b>{account.hasPassword ? 'Подключено' : 'Не настроено'}</b>
              </div>
              <div className="login-method external-route"><i className="google-mark">G</i><div><strong>Google</strong><small>Выбирается на защищённой странице OpenAI</small></div><b>Через ChatGPT</b></div>
              <div className="login-method external-route"><i className="apple-mark">●</i><div><strong>Apple</strong><small>Выбирается на защищённой странице OpenAI</small></div><b>Через ChatGPT</b></div>
            </div>
            <p className="oauth-note"><strong>Почему через ChatGPT:</strong> Google и Apple подтверждают личность на странице OpenAI, а сервис получает только стабильную учётную запись и email. Пароли Google, Apple или ChatGPT здесь не хранятся.</p>
          </article>

          <article className="account-section-card">
            <div className="account-section-title"><span>03</span><div><h3>{account.hasPassword ? 'Изменить пароль' : 'Создать пароль'}</h3><p>{account.hasPassword ? 'После изменения остальные парольные сессии будут завершены' : 'Добавьте независимый вход по email и паролю'}</p></div></div>
            <form className="account-form password-form" onSubmit={savePassword}>
              {account.hasPassword && <label className="account-form-wide"><span>Текущий пароль</span><input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>}
              <label><span>Новый пароль</span><input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={128} placeholder="Не меньше 12 символов" required /></label>
              <label><span>Повторите новый пароль</span><input value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
              <div className="account-form-actions"><small>Используйте уникальную длинную фразу, которой нет в других сервисах.</small><button className="button primary" disabled={busy === 'password'} type="submit">{busy === 'password' ? 'Сохраняю…' : account.hasPassword ? 'Изменить пароль' : 'Создать пароль'}</button></div>
            </form>
          </article>
        </section>
      </div>
    </main>
  );
}
