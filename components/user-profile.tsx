"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { Mail, Phone, Calendar, CheckSquare, Target, Edit2, Save, X } from "lucide-react"

interface UserStats {
  tasksCount: number
  goalsCount: number
  eventsCount: number
}

export function UserProfile() {
  const [user, setUser] = useState<any>(null)
  const [phone, setPhone] = useState("")
  const [blooNumber, setBlooNumber] = useState("")
  const [imessageConnected, setImessageConnected] = useState(false)
  const [editingPhone, setEditingPhone] = useState(false)
  const [newPhone, setNewPhone] = useState("")
  const [editingBloo, setEditingBloo] = useState(false)
  const [newBlooNumber, setNewBlooNumber] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [stats, setStats] = useState<UserStats>({ tasksCount: 0, goalsCount: 0, eventsCount: 0 })

  useEffect(() => {
    loadUserData()
  }, [])

  const loadUserData = async () => {
    try {
      // Get current user
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
      if (authError || !authUser) return

      setUser(authUser)

      // Get session for API call
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (sessionError || !session) {
        console.error("No session available")
        return
      }

      // Get phone via API endpoint (bypasses RLS)
      const phoneResponse = await fetch("/api/user/phone/get", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      if (phoneResponse.ok) {
        const phoneData = await phoneResponse.json()
        console.log("[Frontend] Phone loaded:", phoneData.phone)
        setPhone(phoneData.phone || "")
        setNewPhone(phoneData.phone || "")
      }

      // Get Bloo number via API
      const blooResponse = await fetch("/api/user/bloo", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      if (blooResponse.ok) {
        const blooData = await blooResponse.json()
        console.log("[Frontend] Bloo number loaded:", blooData.blooNumber)
        setBlooNumber(blooData.blooNumber || "")
        setNewBlooNumber(blooData.blooNumber || "")
      }

      // Get stats
      const [tasksData, goalsData, eventsData] = await Promise.all([
        supabase.from("tasks").select("id", { count: "exact" }).eq("user_id", authUser.id),
        supabase.from("goals").select("id", { count: "exact" }).eq("user_id", authUser.id),
        supabase.from("calendar_events").select("id", { count: "exact" }).eq("user_id", authUser.id),
      ])

      setStats({
        tasksCount: tasksData.count || 0,
        goalsCount: goalsData.count || 0,
        eventsCount: eventsData.count || 0,
      })
    } catch (error) {
      console.error("Error loading user data:", error)
    }
  }

  const handleSavePhone = async () => {
    if (!newPhone) {
      toast.error("Please enter a phone number")
      return
    }

    if (!user) {
      toast.error("Not logged in")
      return
    }

    try {
      setIsLoading(true)

      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (sessionError || !session) {
        toast.error("Not authenticated")
        return
      }

      console.log("[Frontend] Updating phone to:", newPhone)

      // Update via API
      const response = await fetch("/api/user/phone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ phone: newPhone }),
      })

      console.log("[Frontend] Response status:", response.status)

      const responseData = await response.json()
      console.log("[Frontend] Response data:", responseData)

      if (!response.ok) {
        const errorMsg = responseData.error || "Failed to update phone"
        console.error("[Frontend] Update failed:", errorMsg)
        toast.error(errorMsg)
        return
      }

      console.log("[Frontend] Update successful!")
      
      // Set the normalized phone that was saved (from API response)
      const savedPhone = responseData.phone
      setPhone(savedPhone)
      setNewPhone(savedPhone)
      setEditingPhone(false)

      // Send welcome message
      try {
        const welcomeResponse = await fetch("/api/user/welcome-message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ phone: savedPhone }),
        })

        if (welcomeResponse.ok) {
          const welcomeData = await welcomeResponse.json()
          
          if (welcomeData.sent) {
            toast.success("✅ Welcome message sent to your phone!")
          } else {
            toast.success("📱 Phone number updated!")
            toast.message("Welcome message preview:\n\n" + welcomeData.welcomeMessage, { duration: 8000 })
          }
        } else {
          toast.success("📱 Phone number updated!")
        }
      } catch (welcomeError) {
        console.error("[Frontend] Error sending welcome message:", welcomeError)
        toast.success("📱 Phone number updated!")
      }
    } catch (error) {
      console.error("[Frontend] Exception:", error)
      const errorMsg = error instanceof Error ? error.message : "Failed to update phone number"
      toast.error(errorMsg)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCancel = () => {
    setNewPhone(phone)
    setEditingPhone(false)
  }

  const handleSaveBloo = async () => {
    if (!newBlooNumber) {
      toast.error("Please enter a Bloo number")
      return
    }

    if (!user) {
      toast.error("Not logged in")
      return
    }

    try {
      setIsLoading(true)

      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (sessionError || !session) {
        toast.error("Not authenticated")
        return
      }

      console.log("[Frontend] Saving Bloo number:", newBlooNumber)

      const response = await fetch("/api/user/bloo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ blooNumber: newBlooNumber }),
      })

      const responseData = await response.json()
      console.log("[Frontend] Bloo response:", responseData)

      if (!response.ok) {
        const errorMsg = responseData.error || "Failed to save Bloo number"
        console.error("[Frontend] Save failed:", errorMsg)
        toast.error(errorMsg)
        return
      }

      console.log("[Frontend] Bloo number saved!")
      const savedBlooNumber = responseData.blooNumber
      setBlooNumber(savedBlooNumber)
      setNewBlooNumber(savedBlooNumber)
      setEditingBloo(false)
      toast.success("✅ Bloo number saved! Incoming messages will now create tasks.")
    } catch (error) {
      console.error("[Frontend] Exception:", error)
      const errorMsg = error instanceof Error ? error.message : "Failed to save Bloo number"
      toast.error(errorMsg)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCancelBloo = () => {
    setNewBlooNumber(blooNumber)
    setEditingBloo(false)
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Loading profile...</p>
      </div>
    )
  }

  return (
    <div className="h-full bg-background flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 md:p-8">
          <div className="max-w-2xl mx-auto space-y-6 md:space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-2xl md:text-4xl font-bold">Account Settings</h1>
          <p className="text-muted-foreground text-sm md:text-base">Manage your account and iMessage integration</p>
        </div>

        {/* Profile Card */}
        <div className="border border-border/50 rounded-lg p-4 md:p-8 glass-strong backdrop-blur-xl space-y-6">
          {/* Email Section */}
          <div className="space-y-2">
            <label className="text-xs md:text-sm font-semibold text-foreground flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" />
              Email Address
            </label>
            <div className="bg-muted/50 border border-border/30 rounded-lg p-3 text-foreground font-medium text-sm">
              {user.email}
            </div>
            <p className="text-xs text-muted-foreground">Your registered email cannot be changed</p>
          </div>

          {/* Phone Section - iMessage Number */}
          <div className="space-y-2 pt-4 border-t border-border/30">
            <label className="text-xs md:text-sm font-semibold text-foreground flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              iMessage Phone Number
            </label>
            
            {!editingPhone ? (
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-muted/50 border border-border/30 rounded-lg p-3">
                <span className="font-medium text-foreground text-sm break-all">
                  {phone || "No phone number set"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingPhone(true)}
                  className="gap-2 w-full md:w-auto"
                >
                  <Edit2 className="h-4 w-4" />
                  Edit
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <Input
                  type="tel"
                  placeholder="+91 XXXXXXXXXX"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  disabled={isLoading}
                  className="font-medium text-sm"
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={handleSavePhone}
                    disabled={isLoading}
                    className="gap-2 flex-1"
                  >
                    <Save className="h-4 w-4" />
                    {isLoading ? "Saving..." : "Save Number"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleCancel}
                    disabled={isLoading}
                    className="gap-2 flex-1"
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Use E.164 format (e.g., +1 2025551234). This number will receive iMessage and create tasks/goals/events automatically.
            </p>
          </div>

          {/* Bloo Number Section - For Incoming Messages */}
          <div className="space-y-2 pt-4 border-t border-border/30">
            <label className="text-xs md:text-sm font-semibold text-foreground flex items-center gap-2">
              <Phone className="h-4 w-4 text-blue-500" />
              Bloo Bound Number (Optional)
            </label>
            
            {!editingBloo ? (
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-muted/50 border border-border/30 rounded-lg p-3">
                <div className="flex-1">
                  <span className="font-medium text-foreground text-sm break-all">
                    {blooNumber || "Not set"}
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">
                    {blooNumber 
                      ? "✓ Incoming messages to this number will create tasks" 
                      : "Set this to receive incoming messages"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingBloo(true)}
                  className="gap-2 w-full md:w-auto"
                >
                  <Edit2 className="h-4 w-4" />
                  Edit
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <Input
                  type="tel"
                  placeholder="+1 (424) 513-4881"
                  value={newBlooNumber}
                  onChange={(e) => setNewBlooNumber(e.target.value)}
                  disabled={isLoading}
                  className="font-medium text-sm"
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={handleSaveBloo}
                    disabled={isLoading}
                    className="gap-2 flex-1"
                  >
                    <Save className="h-4 w-4" />
                    {isLoading ? "Saving..." : "Save Bloo Number"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleCancelBloo}
                    disabled={isLoading}
                    className="gap-2 flex-1"
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The phone number Bloo assigned to you (e.g., +1 (424) 513-4881). When someone texts this number, it creates a task in your calendar.
            </p>
          </div>

          {/* Stats Section */}
          <div className="space-y-3 pt-4 border-t border-border/30">
            <h3 className="text-xs md:text-sm font-semibold text-foreground">Your Activity</h3>
            <div className="grid grid-cols-3 gap-2 md:gap-4">
              <div className="bg-muted/50 border border-border/30 rounded-lg p-3 md:p-4 text-center space-y-2">
                <div className="flex items-center justify-center gap-1 md:gap-2 text-primary">
                  <CheckSquare className="h-4 w-4 md:h-5 md:w-5" />
                  <span className="text-lg md:text-2xl font-bold">{stats.tasksCount}</span>
                </div>
                <p className="text-xs text-muted-foreground">Tasks Created</p>
              </div>
              <div className="bg-muted/50 border border-border/30 rounded-lg p-3 md:p-4 text-center space-y-2">
                <div className="flex items-center justify-center gap-1 md:gap-2 text-purple-500">
                  <Target className="h-4 w-4 md:h-5 md:w-5" />
                  <span className="text-lg md:text-2xl font-bold">{stats.goalsCount}</span>
                </div>
                <p className="text-xs text-muted-foreground">Goals Created</p>
              </div>
              <div className="bg-muted/50 border border-border/30 rounded-lg p-3 md:p-4 text-center space-y-2">
                <div className="flex items-center justify-center gap-1 md:gap-2 text-blue-500">
                  <Calendar className="h-4 w-4 md:h-5 md:w-5" />
                  <span className="text-lg md:text-2xl font-bold">{stats.eventsCount}</span>
                </div>
                <p className="text-xs text-muted-foreground">Events Created</p>
              </div>
            </div>
          </div>

          {/* iMessage Status */}
          <div className="space-y-3 pt-4 border-t border-border/30">
            <h3 className="text-xs md:text-sm font-semibold text-foreground">iMessage Features</h3>
            <div className="space-y-2">
              <div className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg">
                <span className="text-green-600 dark:text-green-400 text-lg mt-0.5 flex-shrink-0">✓</span>
                <div>
                  <p className="text-xs md:text-sm font-medium">Fuzzy Message Understanding</p>
                  <p className="text-xs text-muted-foreground">Handles typos, spelling errors, and casual language</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg">
                <span className="text-green-600 dark:text-green-400 text-lg mt-0.5 flex-shrink-0">✓</span>
                <div>
                  <p className="text-xs md:text-sm font-medium">Auto Task/Goal/Event Creation</p>
                  <p className="text-xs text-muted-foreground">Send any message and AI will create the right item</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg">
                <span className="text-green-600 dark:text-green-400 text-lg mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-medium">Smart Date Parsing</p>
                  <p className="text-xs text-muted-foreground">Understands "tomorrow", "next week", "feb 15", etc.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg">
                <span className="text-green-600 dark:text-green-400 text-lg mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-medium">Instant Sync</p>
                  <p className="text-xs text-muted-foreground">Tasks/goals/events appear in your app in real-time</p>
                </div>
              </div>
            </div>
          </div>

          {/* Example Messages */}
          <div className="space-y-3 pt-4 border-t border-border/30">
            <h3 className="text-sm font-semibold text-foreground">Example Messages</h3>
            <div className="space-y-2 text-sm">
              <div className="p-3 bg-muted/30 rounded-lg">
                <p className="font-mono text-xs mb-1">💬 "buy groceries or something"</p>
                <p className="text-xs text-muted-foreground">→ Creates task: "buy groceries"</p>
              </div>
              <div className="p-3 bg-muted/30 rounded-lg">
                <p className="font-mono text-xs mb-1">💬 "call dad tmmorow pls"</p>
                <p className="text-xs text-muted-foreground">→ Creates task: "call dad" (tomorrow)</p>
              </div>
              <div className="p-3 bg-muted/30 rounded-lg">
                <p className="font-mono text-xs mb-1">💬 "schdule workout session next week"</p>
                <p className="text-xs text-muted-foreground">→ Creates event: "workout session" (next week)</p>
              </div>
              <div className="p-3 bg-muted/30 rounded-lg">
                <p className="font-mono text-xs mb-1">💬 "i wanna maybe learn coding or whatever"</p>
                <p className="text-xs text-muted-foreground">→ Creates goal: "learn coding"</p>
              </div>
            </div>
          </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
