import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

export default defineConfig({
  testDir: '.', testMatch: 'review.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:4177', headless: true, channel: process.platform === 'darwin' ? 'chrome' : undefined },
  webServer: {
    cwd: resolve(__dirname, '../..'),
    command: 'pnpm exec vite --host 127.0.0.1 --port 4177 --strictPort --config tests/regressions/vite.config.ts',
    url: 'http://127.0.0.1:4177/tests/regressions/index.html', timeout: 30000,
  },
})
