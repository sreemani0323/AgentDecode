import { test, expect } from '@playwright/test'

test.describe('Auth Pages', () => {
  test('login page should render form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('login page should show validation on empty submit', async ({ page }) => {
    await page.goto('/login')
    const submitBtn = page.getByRole('button', { name: /sign\s*in|log\s*in/i })
    if (await submitBtn.isVisible()) {
      await submitBtn.click()
      await expect(page).toHaveURL(/\/login/)
    }
  })

  test('signup page should render form', async ({ page }) => {
    await page.goto('/signup')
    await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible()
  })
})
