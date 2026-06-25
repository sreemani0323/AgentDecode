import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

// Load .env.local manually
const envPath = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const [key, ...vals] = line.split('=')
    if (key && vals.length > 0) {
      process.env[key.trim()] = vals.join('=').trim()
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Supabase URL or Service Role Key missing in E2E tests')
}

// Create a Supabase admin client to create/cleanup the user
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
})

test.describe('Onboarding Wizard Flow', () => {
  let testUser: any = null
  const testEmail = `onboarding-e2e-${Date.now()}@agentdecode.com`
  const testPassword = 'Password123!'

  test.beforeAll(async () => {
    console.log(`Creating test user: ${testEmail}`)
    // 1. Create a confirmed user using admin API
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { full_name: 'E2E Onboarding Tester' }
    })

    if (error || !data.user) {
      console.error('Failed to create user:', error)
      throw new Error(`Failed to create test user: ${error?.message}`)
    }
    testUser = data.user
    console.log(`User created successfully with ID: ${testUser.id}`)
  })

  test.afterAll(async () => {
    if (testUser) {
      console.log(`Deleting test user: ${testUser.id}`)
      // 2. Clean up projects, orgs, and user
      const { data: orgMember } = await supabaseAdmin
        .from('org_members')
        .select('org_id')
        .eq('user_id', testUser.id)
        .maybeSingle()

      if (orgMember) {
        const { data: projects } = await supabaseAdmin
          .from('projects')
          .select('id')
          .eq('org_id', orgMember.org_id)

        const projectIds = (projects || []).map(p => p.id)
        for (const pId of projectIds) {
          await supabaseAdmin.from('projects').delete().eq('id', pId)
        }
      }

      await supabaseAdmin.auth.admin.deleteUser(testUser.id)
      console.log('Cleanup finished')
    }
  })

  test('should go through all 3 steps successfully and receive a trace', async ({ page }) => {
    // Listen to browser console and errors
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()))
    page.on('pageerror', err => console.error('BROWSER PAGE ERROR:', err.message))

    // 1. Go to login
    await page.goto('/login')
    await page.fill('input[type="email"]', testEmail)
    await page.fill('input[type="password"]', testPassword)
    await page.click('button[type="submit"]')

    // 2. We should be redirected to /dashboard and see the onboarding wizard
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 })
    await expect(page.locator('text=Welcome to AgentDecode')).toBeVisible()

    // --- Step 1: Create project ---
    await expect(page.locator('text=Create your first project')).toBeVisible()
    const projectNameInput = page.locator('input[placeholder="e.g. Customer Support Agent"]')
    await projectNameInput.fill('E2E Test Project')
    await page.click('button:has-text("Create Project")')

    // --- Step 2: Get API key ---
    await expect(page.locator('text=Get your API key')).toBeVisible()
    const generateBtn = page.locator('button:has-text("Generate API Key")')
    await generateBtn.click()

    // --- Step 3: Send First Trace ---
    await expect(page.locator('text=Send your first trace')).toBeVisible()
    await expect(page.locator('text=Waiting for your first trace…')).toBeVisible()

    // Read the API key from the DOM
    const apiKeyContainer = page.locator('code')
    await expect(apiKeyContainer).toBeVisible()
    const apiKey = await apiKeyContainer.innerText()
    expect(apiKey).toContain('al_')

    // Send a test trace via the ingest endpoint using fetch request from page
    const response = await page.request.post('/api/ingest', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        session_name: 'E2E Test Session',
        spans: [
          {
            name: 'llm.call',
            span_type: 'llm',
            status: 'ok',
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            model: 'gpt-4o',
            input: { prompt: 'Hello from Playwright E2E' },
            output: { response: 'Hello!' },
            input_tokens: 5,
            output_tokens: 5,
          }
        ]
      }
    })

    expect(response.ok()).toBe(true)
    const resBody = await response.json()
    expect(resBody.spans_ingested).toBe(1)

    // The polling in the component should detect the trace and show "Trace received!"
    await expect(page.locator('text=Trace received!')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('button:has-text("View your project dashboard")')).toBeVisible()

    // Click it and verify we navigate to the project dashboard page
    await page.click('button:has-text("View your project dashboard")')
    await expect(page).toHaveURL(/\/projects\/.+/)
  })
})
