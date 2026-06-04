import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const envContent = fs.readFileSync('.env.local', 'utf-8')
for (const line of envContent.split('\n')) {
  const [key, ...vals] = line.split('=')
  if (key && vals.length > 0) {
    process.env[key.trim()] = vals.join('=').trim()
  }
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function check() {
  const projectId = '0c975569-29f5-4532-9aa2-f3081be2dd4f'
  
  const { data: sessions } = await supabase.from('sessions').select('*').eq('project_id', projectId)
  console.log('Sessions:', sessions)
  
  const { data: spans } = await supabase.from('spans').select('*').eq('project_id', projectId)
  console.log('Spans:', spans)
}

check()
