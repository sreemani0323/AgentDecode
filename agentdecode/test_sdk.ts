import { createClient } from '@supabase/supabase-js'
import { AgentDecode } from './packages/sdk/dist/index.js'
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

async function runTest() {
  console.log('1. Setting up test data in Supabase...')
  
  // Create a dummy org
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .insert({ name: 'SDK Test Org', slug: 'sdk-test-' + Date.now() })
    .select('id')
    .single()
    
  if (orgErr) {
    console.error('Error creating org:', orgErr)
    return
  }
  
  // Create a dummy project
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .insert({ org_id: org.id, name: 'SDK Test Project' })
    .select('id')
    .single()
    
  if (projErr) {
    console.error('Error creating project:', projErr)
    return
  }

  // Generate an API key
  const randomBytes = new Uint8Array(16)
  crypto.getRandomValues(randomBytes)
  const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const rawKey = "al_" + hex
  const hashedKey = await hashApiKey(rawKey)
  
  const { error: keyErr } = await supabase
    .from('api_keys')
    .insert({
      project_id: project.id,
      name: 'SDK Test Key',
      key_hash: hashedKey,
      key_prefix: rawKey.slice(0, 7),
      is_active: true
    })
    
  if (keyErr) {
    console.error('Error creating API key:', keyErr)
    return
  }
  
  console.log(`2. Project ID: ${project.id}`)
  console.log(`   API Key: ${rawKey}`)
  
  console.log('3. Initializing AgentDecode SDK...')
  const lens = new AgentDecode({
    apiKey: rawKey,
    projectId: project.id,
    endpoint: 'http://localhost:3000/api/ingest',
  })
  
  console.log('4. Tracing a dummy function...')
  const sessionId = `test_session_${Date.now()}`
  
  const mockLLM = lens.trace(
    'test_llm_call',
    { type: 'llm', model: 'gpt-4o' },
    async (input: string) => {
      console.log('   Inside the traced function...')
      await new Promise(resolve => setTimeout(resolve, 500))
      return `Response to: ${input}`
    }
  )
  
  try {
    const result = await mockLLM(sessionId, 'Hello SDK!')
    console.log('   Function returned:', result)
  } catch (e) {
    console.error('Function failed:', e)
  }
  
  console.log('5. Waiting 2 seconds for background ingest request to complete...')
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // Find the session ID (UUID)
  const { data: sessionData, error: sessionErr } = await supabase
    .from('sessions')
    .select('id')
    .eq('project_id', project.id)
    .eq('external_id', sessionId)
    .single()
    
  if (sessionErr || !sessionData) {
    console.error('Error finding session or session not created:', sessionErr)
    return
  }

  // Verify span was created
  const { data: spans, error: spanErr } = await supabase
    .from('spans')
    .select('id, name, duration_ms, input, output')
    .eq('project_id', project.id)
    .eq('session_id', sessionData.id)
    
  if (spanErr) {
    console.error('Error checking spans:', spanErr)
    return
  }
  
  if (spans && spans.length > 0) {
    console.log('\n✅ TEST PASSED! SDK successfully traced and ingested the span:')
    console.log(JSON.stringify(spans, null, 2))
  } else {
    console.log('\n❌ TEST FAILED. No spans found in the database for this session.')
  }
}

runTest().catch(console.error)
