import { test, expect } from '@playwright/test'
import { join } from 'node:path'

test('onboarding can finish and reopen without changing hook order', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/tests/regressions/index.html')
  await page.getByRole('button', { name: '稍后配置并继续' }).click()
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('status')).toHaveText('工作台已就绪')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '重新打开引导' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(errors).toEqual([])
  if (process.env.REVIEW_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.REVIEW_SCREENSHOT_DIR, 'onboarding.png'), fullPage: true })
})

test('3 MB path image uses the 10 MB image limit through the real bridge', async ({ page }) => {
  await page.goto('/tests/regressions/index.html?image=normal')
  const image = page.locator('.document-preview-image-wrapper img')
  await expect(image).toBeVisible()
  await expect(image).toHaveJSProperty('naturalWidth', 1)
  const requests = await page.evaluate(() => (window as unknown as { previewRequests: Array<{ maxBytes?: number }> }).previewRequests)
  if (process.env.REVIEW_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.REVIEW_SCREENSHOT_DIR, 'image-preview.png'), fullPage: true })
  expect(requests).toHaveLength(1)
  expect(requests[0].maxBytes === undefined || requests[0].maxBytes === 10 * 1024 * 1024).toBe(true)
})

test('images above 10 MB stay bounded instead of loading a truncated data URL', async ({ page }) => {
  await page.goto('/tests/regressions/index.html?image=large')
  await expect(page.locator('.document-preview-note')).toBeVisible()
  await expect(page.locator('.document-preview-image-wrapper img')).toHaveCount(0)
})
