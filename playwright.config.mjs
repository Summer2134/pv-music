import { defineConfig, devices } from '@playwright/test';
// e2e-тесты лендинга (landing/index.html). Локально можно указать свой Chromium: PW_CHROMIUM=/путь/к/chromium
export default defineConfig({
  testDir: 'e2e',
  reporter: [['list']],
  use: { launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
