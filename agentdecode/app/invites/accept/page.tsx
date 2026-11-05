"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ShieldCheck, AlertCircle, Loader2 } from "lucide-react"

function AcceptInviteContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token")

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleAccept = async () => {
    if (!token) {
      setError("Invitation token is missing from the URL.")
      return
    }

    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (res.status === 401) {
          setError("You must sign in with the invited email address to accept.")
        } else {
          setError(data.error || "Failed to accept invitation.")
        }
      } else {
        setSuccess(true)
        setTimeout(() => {
          router.push("/dashboard")
        }, 2000)
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">Organization Invitation</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You have been invited to collaborate on an AgentDecode organization.
          </p>
        </div>

        {error && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>{error}</div>
          </div>
        )}

        {success ? (
          <div className="mt-6 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-4 text-center text-sm text-emerald-600 dark:text-emerald-400">
            <p className="font-medium">Invitation accepted!</p>
            <p className="mt-1 text-xs">Redirecting you to the dashboard...</p>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <Button
              onClick={handleAccept}
              disabled={loading || !token}
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Accepting...
                </>
              ) : (
                "Accept Invitation"
              )}
            </Button>
            <div className="text-center text-xs text-muted-foreground">
              <Link href="/dashboard" className="hover:underline">
                Return to Dashboard
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <AcceptInviteContent />
    </Suspense>
  )
}

