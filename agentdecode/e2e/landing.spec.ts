import { test, expect } from '@playwright/test'

test.describe('Landing Page', () => {
  test('should load and display the hero section', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/AgentDecode/i)
    await expect(page.locator('body')).toBeVisible()
  })

  test('should have navigation links', async ({ page }) => {
    await page.goto('/')
    const loginLink = page.getByRole('link', { name: /log\s*in|sign\s*in/i })
    await expect(loginLink).toBeVisible()
  })

  test('should navigate to login page', async ({ page }) => {
    await page.goto('/')
    const loginLink = page.getByRole('link', { name: /log\s*in|sign\s*in/i })
    await loginLink.click()
    await expect(page).toHaveURL(/\/login/)
  })
})
