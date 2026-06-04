import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: { users } } = await supabase.auth.admin.listUsers();
  if (users.length > 0) {
    const user = users[0];
    const { data, error } = await supabase.auth.admin.updateUserById(
      user.id,
      { password: 'password123' }
    );
    if (error) {
      console.log('Error updating user', error);
    } else {
      console.log(`User ${user.email} updated with password: password123`);
    }
  } else {
    console.log('No users found');
  }
}
run();
