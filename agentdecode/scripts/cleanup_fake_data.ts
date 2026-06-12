import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

// Load .env.local
const envContent = fs.readFileSync('.env.local', 'utf-8')
for (const line of envContent.split('\n')) {
  const [key, ...vals] = line.split('=')
  if (key && vals.length > 0) {
    process.env[key.trim()] = vals.join('=').trim()
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function cleanup() {
  console.log('Looking for project named "fakeproject"...')

  const { data: projects, error: findErr } = await supabase
    .from('projects')
    .select('id, name')
    .eq('name', 'fakeproject')

  if (findErr) {
    console.error('Error finding project:', findErr.message)
    return
  }

  if (!projects || projects.length === 0) {
    console.log('No project named "fakeproject" found. Nothing to delete.')
    return
  }

  for (const project of projects) {
    const pid = project.id
    console.log(`Deleting project "${project.name}" (${pid})...`)

    // 1. Get all sessions for this project
    const { data: sessions } = await supabase
      .from('sessions')
      .select('id')
      .eq('project_id', pid)

    const sessionIds = sessions?.map(s => s.id) || []

    if (sessionIds.length > 0) {
      // 2. Get all spans for these sessions
      const { data: spans } = await supabase
        .from('spans')
        .select('id')
        .in('session_id', sessionIds)

      const spanIds = spans?.map(s => s.id) || []

      if (spanIds.length > 0) {
        // 3. Delete eval_scores for these spans
        const { error: evalErr } = await supabase
          .from('eval_scores')
          .delete()
          .in('span_id', spanIds)
        if (evalErr) console.error('  eval_scores delete error:', evalErr.message)
        else console.log(`  Deleted eval_scores for ${spanIds.length} spans`)

        // 4. Delete ai_explanations for these spans
        const { error: aiErr } = await supabase
          .from('ai_explanations')
          .delete()
          .in('span_id', spanIds)
        if (aiErr) console.error('  ai_explanations delete error:', aiErr.message)
        else console.log(`  Deleted ai_explanations`)

        // 5. Delete issue_spans for these spans
        const { error: isErr } = await supabase
          .from('issue_spans')
          .delete()
          .in('span_id', spanIds)
        if (isErr) console.error('  issue_spans delete error:', isErr.message)
        else console.log(`  Deleted issue_spans`)

        // 6. Delete spans
        const { error: spanErr } = await supabase
          .from('spans')
          .delete()
          .in('session_id', sessionIds)
        if (spanErr) console.error('  spans delete error:', spanErr.message)
        else console.log(`  Deleted ${spanIds.length} spans`)
      }

      // 7. Delete sessions
      const { error: sessErr } = await supabase
        .from('sessions')
        .delete()
        .eq('project_id', pid)
      if (sessErr) console.error('  sessions delete error:', sessErr.message)
      else console.log(`  Deleted ${sessionIds.length} sessions`)
    }

    // 8. Delete issues for this project
    const { error: issueErr } = await supabase
      .from('issues')
      .delete()
      .eq('project_id', pid)
    if (issueErr) console.error('  issues delete error:', issueErr.message)
    else console.log('  Deleted issues')

    // 9. Delete alert_rules for this project
    const { error: alertErr } = await supabase
      .from('alert_rules')
      .delete()
      .eq('project_id', pid)
    if (alertErr) console.error('  alert_rules delete error:', alertErr.message)
    else console.log('  Deleted alert_rules')

    // 10. Delete api_keys for this project
    const { error: keyErr } = await supabase
      .from('api_keys')
      .delete()
      .eq('project_id', pid)
    if (keyErr) console.error('  api_keys delete error:', keyErr.message)
    else console.log('  Deleted api_keys')

    // 11. Delete the project itself
    const { error: projErr } = await supabase
      .from('projects')
      .delete()
      .eq('id', pid)
    if (projErr) console.error('  project delete error:', projErr.message)
    else console.log(`  Deleted project "${project.name}"`)
  }

  console.log('\nCleanup complete!')
}

cleanup().catch(console.error)
