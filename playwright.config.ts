import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const systemChrome = '/usr/bin/google-chrome-stable';

export default defineConfig({
  testDir: './packages/client/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    launchOptions: existsSync(systemChrome) ? { executablePath: systemChrome } : {},
  },
  projects: [
    {
      name: 'ui',
      testIgnore: /pwa\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' },
    },
    {
      name: 'pwa',
      testMatch: /pwa\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], serviceWorkers: 'allow' },
    },
  ],
  webServer: {
    command: 'npm run build -w @strata/client && npm run preview -w @strata/client -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
