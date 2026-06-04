import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: { users } } = await supabase.auth.admin.listUsers();
  if (users.length > 0) {
    const user = users[0];
    const { data: link, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });
    if (error) {
      console.log('Error generating link', error);
    } else {
      console.log(`MAGIC_LINK=${link.properties.action_link}`);
    }
  } else {
    console.log('No users found');
  }
}
run();
