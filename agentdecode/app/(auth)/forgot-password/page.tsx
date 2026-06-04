"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Activity, ArrowLeft, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import Link from "next/link"

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const supabase = createClient()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/auth/reset-password",
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setSent(true)
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-md rounded-xl border border-muted/50 bg-card/80  p-8 shadow-2xl">
      <div className="space-y-3 flex flex-col items-center text-center pb-6">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-2">
          <Activity className="w-6 h-6 text-primary" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl text-foreground font-semibold">AgentDecode</h1>
          <p className="text-muted-foreground text-base">
            Reset your password
          </p>
        </div>
      </div>

      {sent ? (
        <div className="space-y-5">
          <div className="text-center space-y-4 py-4">
            <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
              <Mail className="w-7 h-7 text-green-400" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-medium text-foreground">Check your email</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                We&apos;ve sent a password reset link to{" "}
                <span className="text-foreground font-medium">{email}</span>. Click the
                link in the email to set a new password.
              </p>
            </div>
          </div>

          <div className="flex justify-center pt-2">
            <Link
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to sign in
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2 text-left">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="bg-background/50"
              />
            </div>

            {error && (
              <p className="text-sm text-red-500 font-medium">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={loading}
            >
              {loading ? "Sending..." : "Send Reset Link"}
            </Button>
          </form>

          <div className="flex justify-center pt-4">
            <Link
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to sign in
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
