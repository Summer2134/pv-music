import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const page_ = pathToFileURL(resolve('landing/index.html')).href;

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(page_);
  test.info().annotations.push({ type: 'errors', description: String(errors.length) });
  page.errors = errors;
});

test('первый экран: заголовок, кнопка входа и пример чата видны сразу', async ({ page }) => {
  await expect(page).toHaveTitle('Потный Вафелс');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('холодных');
  await expect(page.getByRole('link', { name: /Зайти на сервер/ })).toHaveAttribute('href', 'https://discord.gg/vafels');
  // Чат не пустой с первого кадра — без ожидания и кликов.
  await expect(page.locator('#feed')).toContainText('Пати собрана');
  expect(page.errors).toEqual([]);
});

test('кнопка-команда: бот «печатает», потом отвечает карточкой', async ({ page }) => {
  await page.getByRole('button', { name: '/питомец' }).click();
  await expect(page.locator('#feed .typing')).toBeVisible();
  await expect(page.locator('#feed')).toContainText('Вернулся из приключения');
  await expect(page.getByRole('button', { name: '/питомец' })).toHaveAttribute('aria-pressed', 'true');
});

test('в чате не больше 4 сообщений, старые уходят', async ({ page }) => {
  for (const name of ['/ежедневка', '/волна', '/дота']) {
    await page.getByRole('button', { name }).click();
    await expect(page.locator('#feed .typing')).toHaveCount(0);
  }
  await expect(page.locator('#feed .msg')).toHaveCount(4);
  await expect(page.locator('#feed')).toContainText('Властелин');
});

test('нет горизонтальной прокрутки', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('копирование приглашения отвечает пользователю', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.getByRole('button', { name: 'Скопировать' }).click();
  await expect(page.locator('#copied')).toHaveText(/Скопировано|Выделено/);
});
