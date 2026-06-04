"use client"

import { LogOut } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

export default function SignOutButton() {
  const router = useRouter()
  const supabase = createClient()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <Button 
      variant="ghost" 
      size="sm" 
      className="w-full justify-start text-muted-foreground hover:text-foreground"
      onClick={handleSignOut}
    >
      <LogOut className="w-4 h-4 mr-2" />
      Sign out
    </Button>
  )
}
