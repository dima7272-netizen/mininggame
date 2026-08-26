import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dig Get Stronger — Баланс-центр',
  description: 'Безопасное управление балансом и игровыми конфигами Dig Get Stronger.',
};

const themeBootstrap = `(() => {
  try {
    const saved = localStorage.getItem('dig-balance-theme');
    const mode = saved === 'light' || saved === 'dark' || saved === 'auto' ? saved : 'auto';
    const resolved = mode === 'auto'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.style.colorScheme = resolved;
  } catch {}
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body>{children}</body>
    </html>
  );
}
