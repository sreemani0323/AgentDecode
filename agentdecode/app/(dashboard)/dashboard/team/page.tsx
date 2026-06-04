"use client"

import { useState, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Users, UserPlus, Crown, Trash2, Mail, Shield } from "lucide-react"

interface Member {
  user_id: string
  role: string
  full_name: string
  avatar_url: string | null
}

export default function TeamPage() {
  const supabase = createClient()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [currentUserRole, setCurrentUserRole] = useState<string>("member")
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviting, setInviting] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  useEffect(() => {
    async function fetchTeam() {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Get user's org
      const { data: membership } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .single()

      if (!membership) {
        setLoading(false)
        return
      }

      setOrgId(membership.org_id)

      // Fetch members via API
      const res = await fetch(`/api/invites?org_id=${membership.org_id}`)
      if (res.ok) {
        const data = await res.json()
        setMembers(data.members || [])
        setCurrentUserRole(data.currentUserRole || "member")
      }

      setLoading(false)
    }

    fetchTeam()
  }, [])

  const handleInvite = async () => {
    if (!orgId || !inviteEmail.trim()) return

    setInviting(true)
    setMessage(null)

    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org_id: orgId, email: inviteEmail.trim() }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to invite" })
      } else {
        setMessage({ type: "success", text: `${inviteEmail} has been added to your team.` })
        setInviteEmail("")
        // Refresh members
        const refreshRes = await fetch(`/api/invites?org_id=${orgId}`)
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json()
          setMembers(refreshData.members || [])
        }
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to invite" })
    } finally {
      setInviting(false)
      setTimeout(() => setMessage(null), 5000)
    }
  }

  const handleRemove = async (userId: string) => {
    if (!orgId) return

    try {
      const res = await fetch("/api/invites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org_id: orgId, user_id: userId }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to remove member" })
      } else {
        setMembers((prev) => prev.filter((m) => m.user_id !== userId))
        setMessage({ type: "success", text: "Member removed." })
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to remove" })
    } finally {
      setConfirmRemove(null)
      setTimeout(() => setMessage(null), 5000)
    }
  }

  if (loading) {
    return (
      <div className="p-8 max-w-3xl mx-auto w-full space-y-8">
        <div className="h-8 w-32 bg-muted/50 animate-pulse rounded" />
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 bg-muted/30 animate-pulse rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl mx-auto w-full space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Team</h1>
        <p className="text-muted-foreground mt-1">
          Manage who has access to your organization&apos;s projects and data.
        </p>
      </div>

      {/* Invite Section — owners only */}
      {currentUserRole === "owner" && (
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Invite a team member</h2>
              <p className="text-xs text-muted-foreground">
                They must have an existing AgentDecode account.
              </p>
            </div>
          </div>

          <div className="flex items-end gap-4">
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="bg-background/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleInvite()
                }}
              />
            </div>
            <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
              <Mail className="w-4 h-4 mr-2" />
              {inviting ? "Inviting..." : "Invite"}
            </Button>
          </div>

          {message && (
            <p
              className={`text-sm font-medium ${
                message.type === "success" ? "text-green-400" : "text-red-400"
              }`}
            >
              {message.text}
            </p>
          )}
        </div>
      )}

      {/* Members List */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center gap-3">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">
            Members ({members.length})
          </h2>
        </div>

        {members.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p>No team members yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {members.map((member) => (
              <div
                key={member.user_id}
                className="px-6 py-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-muted/50 flex items-center justify-center text-sm font-medium text-foreground border border-border">
                    {member.full_name
                      ?.split(" ")
                      .map((n) => n[0])
                      .join("")
                      .toUpperCase()
                      .slice(0, 2) || "??"}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {member.full_name || "Unknown"}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {member.role === "owner" ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <Crown className="w-3 h-3" />
                          Owner
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          <Shield className="w-3 h-3" />
                          Member
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Remove button — only for owners, and cannot remove other owners */}
                {currentUserRole === "owner" && member.role !== "owner" && (
                  <div>
                    {confirmRemove === member.user_id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-red-400">Remove?</span>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleRemove(member.user_id)}
                        >
                          Yes
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmRemove(null)}
                        >
                          No
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-red-400"
                        onClick={() => setConfirmRemove(member.user_id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
