import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: project } = await supabase.from('projects').select('id').limit(1).single();
  const { data: session } = await supabase.from('sessions').select('id').limit(1).single();
  console.log(`PROJECT_ID=${project?.id || 'none'}`);
  console.log(`SESSION_ID=${session?.id || 'none'}`);
}
run();
