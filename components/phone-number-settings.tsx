"use client"

import { useState } from "react"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

export function PhoneNumberSettings() {
  const [phone, setPhone] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const handleSetPhone = async () => {
    if (!phone) {
      toast.error("Please enter your phone number")
      return
    }

    try {
      setIsLoading(true)

      const { data, error } = await supabase.auth.getSession()
      if (error || !data.session) {
        toast.error("Not logged in")
        return
      }

      const response = await fetch("/api/user/phone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ phone }),
      })

      const responseData = await response.json()

      if (!response.ok) {
        const errorMsg = responseData?.error || "Failed to update phone"
        throw new Error(errorMsg)
      }

      toast.success("Phone number updated! Messages from this number will now create tasks/events.")
      setPhone("")
      
      // Optionally refresh the page or refetch user data
      window.location.reload()
    } catch (error) {
      console.error("Error:", error)
      toast.error("Failed to update phone number")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-4 space-y-4 border rounded-lg">
      <h3 className="text-lg font-semibold">Link Phone for iMessage</h3>
      <p className="text-sm text-gray-600">
        Enter your phone number in E.164 format (e.g., +12025551234) to enable iMessage integration
      </p>
      <div className="flex gap-2">
        <Input
          type="tel"
          placeholder="+91 9920261793"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={isLoading}
        />
        <Button onClick={handleSetPhone} disabled={isLoading}>
          {isLoading ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  )
}
