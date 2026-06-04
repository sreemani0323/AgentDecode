import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

async function main() {
  const { data: projects, error } = await supabase.from('projects').select('id, name').limit(1)
  if (error || !projects.length) {
    console.error('No projects found', error)
    return
  }
  const project = projects[0]
  console.log('Project:', project.name)
  
  const rawKey = 'al_' + crypto.randomBytes(16).toString('hex')
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  
  const { error: insertError } = await supabase.from('api_keys').insert({
    project_id: project.id,
    key_hash: keyHash,
    key_prefix: rawKey.substring(0, 12),
    name: 'Demo Key',
    is_active: true
  })
  
  if (insertError) {
    console.error('Insert error', insertError)
  } else {
    console.log('AGENTDECODE_API_KEY=' + rawKey)
  }
}
main()
