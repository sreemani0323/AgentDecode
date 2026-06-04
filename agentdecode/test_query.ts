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
  const { data: sessions, error } = await supabase.from('sessions').select('*').order('created_at', { ascending: false }).limit(5)
  console.log('Sessions:', sessions)
  
  const { data: spans } = await supabase.from('spans').select('*').order('created_at', { ascending: false }).limit(5)
  console.log('Spans:', spans)
}

check()
