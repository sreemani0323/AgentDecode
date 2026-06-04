import { chromium } from 'playwright';

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Testing landing page...');
  await page.goto('http://localhost:3000');
  let title = await page.title();
  console.log(`Landing page title: ${title}`);

  console.log('Testing login page...');
  await page.goto('http://localhost:3000/login');
  let content = await page.content();
  const hasForgotPassword = content.includes('Forgot password?');
  console.log(`Login page: has forgot password link: ${hasForgotPassword}`);

  console.log('Logging in via UI...');
  await page.goto('http://localhost:3000/login');
  await page.fill('input[type="email"]', 'agentdecode_test_1780484517119@gmail.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  // Wait for redirect to dashboard
  await page.waitForURL('http://localhost:3000/dashboard', { timeout: 10000 }).catch(async () => {
    console.log('Timeout waiting for dashboard');
  });
  console.log(`Current URL: ${page.url()}`);

  if (page.url().includes('dashboard')) {
    console.log('Testing dashboard...');
    const dbContent = await page.content();
    console.log(`Dashboard loaded: ${dbContent.includes('Projects')}`);
    
    // Check active nav link
    const dashboardLink = await page.locator('a[href="/dashboard"]').first();
    const classes = await dashboardLink.getAttribute('class');
    console.log(`Dashboard nav link classes: ${classes}`);

    console.log('Testing global issues...');
    await page.goto('http://localhost:3000/dashboard/issues');
    console.log(`Global issues URL: ${page.url()}`);
    console.log(`Global issues body length: ${(await page.content()).length}`);

    console.log('Testing global settings...');
    await page.goto('http://localhost:3000/dashboard/settings');
    console.log(`Global settings URL: ${page.url()}`);

    console.log('Testing project issues...');
    await page.goto('http://localhost:3000/projects/7d300e41-4ae0-4861-ad7e-c17fc564e107/issues');
    console.log(`Project issues URL: ${page.url()}`);

    console.log('Testing trace viewer...');
    await page.goto('http://localhost:3000/sessions/a92ac8a2-cb81-4e8d-a9c8-d883eaabbe2d');
    console.log(`Trace viewer URL: ${page.url()}`);
  }

  await browser.close();
}

run().catch(console.error);
