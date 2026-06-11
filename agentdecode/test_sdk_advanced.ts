import { createClient } from '@supabase/supabase-js'
import { AgentDecode } from '../packages/sdk/dist/index.js'
import crypto from 'crypto'
import fs from 'fs'

const envContent = fs.readFileSync('.env.local', 'utf-8')
for (const line of envContent.split('\n')) {
  const [key, ...vals] = line.split('=')
  if (key && vals.length > 0) {
    process.env[key.trim()] = vals.join('=').trim()
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function waitForSpans(projectId: string, sessionId: string, expectedCount: number, retries = 10): Promise<any[]> {
  for (let i = 0; i < retries; i++) {
    const { data: spans } = await supabase
      .from('spans')
      .select('name, span_type, status, duration_ms, error_message, input, output')
      .eq('project_id', projectId)
      
    if (spans && spans.length >= expectedCount) {
      return spans;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Expected ${expectedCount} spans, but they did not appear in time.`);
}

async function runTests() {
  console.log('--- AgentDecode SDK Test Suite ---');
  console.log('1. Setting up test data in Supabase...')
  
  const { data: org } = await supabase
    .from('organizations')
    .insert({ name: 'SDK Test Org', slug: 'sdk-test-adv-' + Date.now() })
    .select('id')
    .single()
    
  const { data: project } = await supabase
    .from('projects')
    .insert({ org_id: org!.id, name: 'SDK Advanced Test' })
    .select('id')
    .single()

  const rawKey = "al_" + crypto.randomBytes(16).toString('hex')
  const hashedKey = await hashApiKey(rawKey)
  
  await supabase
    .from('api_keys')
    .insert({
      project_id: project!.id,
      name: 'Test Key',
      key_hash: hashedKey,
      key_prefix: rawKey.slice(0, 7),
      is_active: true
    })
  
  console.log(`2. SDK initialized for Project: ${project!.id}`)
  const lens = new AgentDecode({
    apiKey: rawKey,
    endpoint: 'http://localhost:3000/api/ingest',
  })
  
  const sessionId = `test_session_${Date.now()}`
  const session = lens.session({ sessionId })
  
  console.log('3. Running Test Cases...')
  
  // Case 1: Successful Tool Call
  const mockTool = session.trace('search_db', { type: 'tool' }, async (span: any, query: string) => {
    await new Promise(r => setTimeout(r, 100));
    return { results: ['item1', 'item2'] };
  })
  
  // Case 2: Successful LLM Call
  const mockLLM = session.trace('generate_summary', { type: 'llm', model: 'gpt-4o' }, async (span: any, text: string) => {
    await new Promise(r => setTimeout(r, 150));
    return `Summary of: ${text}`;
  })
  
  // Case 3: Failing Call
  const mockFailingLLM = session.trace('parse_json', { type: 'llm', model: 'gpt-3.5' }, async (span: any, text: string) => {
    await new Promise(r => setTimeout(r, 50));
    throw new Error('Unexpected token in JSON');
  })
  
  console.log('   Executing cases...');
  await mockTool('SELECT * FROM users');
  await mockLLM('Long document text here');
  try {
    await mockFailingLLM('{ bad_json }');
  } catch (e) {
    // Expected to throw
  }
  
  await session.end()

  console.log('4. Waiting for spans to be ingested asynchronously (polling up to 10s)...');
  try {
    const spans = await waitForSpans(project!.id, sessionId, 3);
    
    console.log('\n--- Test Results ---');
    
    // Assert Case 1
    const toolSpan = spans.find(s => s.name === 'search_db');
    if (toolSpan && toolSpan.status === 'ok' && toolSpan.span_type === 'tool') {
      console.log('✅ Case 1: Tool trace passed');
    } else {
      console.log('❌ Case 1 Failed:', toolSpan);
    }

    // Assert Case 2
    const llmSpan = spans.find(s => s.name === 'generate_summary');
    if (llmSpan && llmSpan.status === 'ok' && llmSpan.span_type === 'llm') {
      console.log('✅ Case 2: LLM trace passed');
    } else {
      console.log('❌ Case 2 Failed:', llmSpan);
    }

    // Assert Case 3
    const errorSpan = spans.find(s => s.name === 'parse_json');
    if (errorSpan && errorSpan.status === 'error' && errorSpan.error_message === 'Unexpected token in JSON') {
      console.log('✅ Case 3: Error trace passed (caught exception)');
    } else {
      console.log('❌ Case 3 Failed:', errorSpan);
    }

  } catch (err) {
    console.error('❌ Test suite failed:', err);
  }
}

runTests().catch(console.error)
