"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { User, Building2, LogOut, Save } from "lucide-react"

interface Profile {
  full_name: string
  email: string
}

interface Org {
  id: string
  name: string
  slug: string
  role: string
}

export default function SettingsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [profile, setProfile] = useState<Profile>({ full_name: "", email: "" })
  const [org, setOrg] = useState<Org | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingOrg, setSavingOrg] = useState(false)
  const [profileMessage, setProfileMessage] = useState<{
    type: "success" | "error"
    text: string
  } | null>(null)
  const [orgMessage, setOrgMessage] = useState<{
    type: "success" | "error"
    text: string
  } | null>(null)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)

      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        router.push("/login")
        return
      }

      // Fetch profile
      const { data: profileData } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .single()

      setProfile({
        full_name: profileData?.full_name || "",
        email: user.email || "",
      })

      // Fetch org membership
      const { data: membership } = await supabase
        .from("org_members")
        .select("role, org_id, organizations(id, name, slug)")
        .eq("user_id", user.id)
        .single()

      if (membership?.organizations) {
        const orgData = membership.organizations as any
        setOrg({
          id: orgData.id,
          name: orgData.name,
          slug: orgData.slug,
          role: membership.role,
        })
      }

      setLoading(false)
    }

    fetchData()
  }, [])

  async function handleSaveProfile() {
    setSavingProfile(true)
    setProfileMessage(null)

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) return

    const { error } = await supabase
      .from("profiles")
      .update({ full_name: profile.full_name })
      .eq("id", user.id)

    if (error) {
      setProfileMessage({ type: "error", text: "Failed to update profile." })
    } else {
      setProfileMessage({ type: "success", text: "Profile updated successfully." })
    }

    setSavingProfile(false)
    setTimeout(() => setProfileMessage(null), 3000)
  }

  async function handleSaveOrg() {
    if (!org) return

    setSavingOrg(true)
    setOrgMessage(null)

    const { error } = await supabase
      .from("organizations")
      .update({ name: org.name })
      .eq("id", org.id)

    if (error) {
      setOrgMessage({ type: "error", text: "Failed to update organization." })
    } else {
      setOrgMessage({
        type: "success",
        text: "Organization updated successfully.",
      })
    }

    setSavingOrg(false)
    setTimeout(() => setOrgMessage(null), 3000)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push("/login")
  }

  if (loading) {
    return (
      <div className="p-8 max-w-2xl mx-auto w-full space-y-8">
        <div className="h-8 w-32 bg-muted/50 animate-pulse rounded" />
        <div className="space-y-6">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-48 bg-muted/30 animate-pulse rounded-xl"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl mx-auto w-full space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your profile and organization settings.
        </p>
      </div>

      {/* Profile Section */}
      <div className="border border-border rounded-xl bg-card/50 p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <User className="w-5 h-5 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Profile</h2>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="full_name">Full Name</Label>
            <Input
              id="full_name"
              type="text"
              value={profile.full_name}
              onChange={(e) =>
                setProfile((prev) => ({ ...prev, full_name: e.target.value }))
              }
              placeholder="Your full name"
              className="bg-background/50"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={profile.email}
              disabled
              className="bg-background/50 opacity-60 cursor-not-allowed"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed here.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={handleSaveProfile}
              disabled={savingProfile}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <Save className="w-4 h-4 mr-2" />
              {savingProfile ? "Saving..." : "Save Profile"}
            </Button>
            {profileMessage && (
              <p
                className={`text-sm font-medium ${
                  profileMessage.type === "success"
                    ? "text-green-400"
                    : "text-red-400"
                }`}
              >
                {profileMessage.text}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Organization Section */}
      {org && (
        <div className="border border-border rounded-xl bg-card/50 p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Organization</h2>
              <p className="text-xs text-muted-foreground capitalize">
                Role: {org.role}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org_name">Organization Name</Label>
              <Input
                id="org_name"
                type="text"
                value={org.name}
                onChange={(e) =>
                  setOrg((prev) => (prev ? { ...prev, name: e.target.value } : prev))
                }
                disabled={org.role !== "owner"}
                placeholder="Organization name"
                className={`bg-background/50 ${
                  org.role !== "owner" ? "opacity-60 cursor-not-allowed" : ""
                }`}
              />
            </div>

            <div className="space-y-2">
              <Label>Slug</Label>
              <p className="text-sm text-muted-foreground font-mono bg-background/30 px-3 py-2 rounded-md border border-border">
                {org.slug}
              </p>
            </div>

            {org.role !== "owner" && (
              <p className="text-xs text-muted-foreground italic">
                Only the organization owner can change settings.
              </p>
            )}

            {org.role === "owner" && (
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleSaveOrg}
                  disabled={savingOrg}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {savingOrg ? "Saving..." : "Save Organization"}
                </Button>
                {orgMessage && (
                  <p
                    className={`text-sm font-medium ${
                      orgMessage.type === "success"
                        ? "text-green-400"
                        : "text-red-400"
                    }`}
                  >
                    {orgMessage.text}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Danger Zone */}
      <div className="border border-red-500/30 rounded-xl bg-card/50 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-red-500/10 flex items-center justify-center">
            <LogOut className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Danger Zone</h2>
            <p className="text-xs text-muted-foreground">
              Irreversible actions
            </p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          Sign out of your account on this device. You will need to sign in again
          to access your projects.
        </p>

        <Button
          variant="destructive"
          onClick={handleSignOut}
          className="bg-red-600 hover:bg-red-700 text-foreground"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </div>
    </div>
  )
}
