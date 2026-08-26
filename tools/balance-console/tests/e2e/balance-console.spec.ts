import { expect, test } from '@playwright/test';

test('navigates to rooms and stages/reverts an exact large-number edit', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Обзор баланса' })).toBeVisible();
  await expect(page.getByText('9 конфигов')).toBeVisible();

  await page.getByRole('button', { name: 'Комнаты и награды' }).click();
  await expect(page.getByRole('heading', { name: 'Комнаты и награды' })).toBeVisible();
  const hp = page.getByRole('textbox', { name: 'HP комнаты 16' });
  const original = await hp.inputValue();
  await hp.fill((BigInt(original) + BigInt(1)).toString());
  await hp.press('Tab');
  await expect(page.getByText('1 несохранённых изменений')).toBeVisible();
  await page.getByRole('button', { name: /Отменить/ }).click();
  await expect(hp).toHaveValue(original);
});

test('shows source drift and calculates the connected game formulas', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Сравнение источников' }).click();
  await expect(page.getByRole('heading', { name: 'Сравнение версий' })).toBeVisible();
  await expect(page.getByText('5 полей')).toBeVisible();

  await page.getByRole('button', { name: 'Симулятор' }).click();
  await expect(page.getByText('Как игра посчитала')).toBeVisible();
  await expect(page.getByText('Урон за удар')).toBeVisible();
  await expect(page.getByLabel('Фактический урон за удар (из игры)')).toBeVisible();
});

test('shows the complete numbered rewards catalog with editable prices', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Карта наград' }).click();
  await expect(page.getByRole('heading', { name: 'Карта наград' })).toBeVisible();
  await page.getByRole('button', { name: 'Каталог и цены' }).click();
  await expect(page.getByText('75 из 75')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Цена награды 1 / })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Группа из игры' })).toBeVisible();
  await page.getByRole('button', { name: 'Группы наград · 10' }).click();
  await expect(page.getByRole('heading', { name: 'Группы наград' })).toBeVisible();
  await expect(page.getByText('75 / 75')).toBeVisible();
  await expect(page.getByText('Божественные', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Графики и показатели' }).click();
  await expect(page.getByRole('heading', { name: 'Графики прогрессии наград' })).toBeVisible();
  await expect(page.getByText('Состав комнаты 1')).toBeVisible();
  await page.getByRole('button', { name: 'Автогенератор' }).click();
  await expect(page.getByText('1 → 2 → 3 → 5 → 8 → 12 → 17 → 23 → 29 → 0')).toBeVisible();
});

test('never presents a mock publication as a successful DEV release', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Версии и публикации' }).click();
  await expect(page.getByText('Настоящая публикация не подключена')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Опубликовать настоящий DEV' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /через мок/ })).toHaveCount(0);
});
