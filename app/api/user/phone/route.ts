import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  console.log("[PhoneUpdate] Starting...");

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const token = authHeader.substring(7);
    const { phone } = await req.json();

    if (!phone) {
      return NextResponse.json({ error: "Phone required" }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
    );

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user?.id) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const admin = getSupabaseAdminClient();

    // Normalize phone - remove ALL spaces and formatting
    let normalizedPhone = String(phone).trim().replace(/\s+/g, "").replace(/[^\d+]/g, "");
    
    console.log("[PhoneUpdate] Raw input:", phone, "After cleaning:", normalizedPhone);
    
    // If already has +, keep it
    if (!normalizedPhone.startsWith("+")) {
      // Only digits - apply intelligent formatting
      if (/^\d+$/.test(normalizedPhone)) {
        if (normalizedPhone.length > 10) {
          // Has country code, just add +
          normalizedPhone = "+" + normalizedPhone;
        } else if (normalizedPhone.length === 10) {
          // 10 digits - check if Indian format (starts with 6,7,8,9)
          if (/^[6789]/.test(normalizedPhone)) {
            normalizedPhone = "+91" + normalizedPhone;
          } else {
            // Non-Indian 10-digit - warn user to provide country code
            console.log("[PhoneUpdate] Warning: 10-digit number that doesn't look Indian. User should provide country code.");
            normalizedPhone = "+" + normalizedPhone;
          }
        } else {
          // Less than 10 digits, add + anyway
          normalizedPhone = "+" + normalizedPhone;
        }
      }
    }

    console.log("[PhoneUpdate] Final normalized phone:", normalizedPhone);

    console.log("[PhoneUpdate] Saving phone:", normalizedPhone, "for user:", user.id);

    // Update with select to get back the updated row
    const { data: updated, error } = await admin
      .from("user_profiles")
      .update({ phone: normalizedPhone })
      .eq("user_id", user.id)
      .select("phone, user_id");

    console.log("[PhoneUpdate] Update result:", { error, updated });

    if (error) {
      console.error("[PhoneUpdate] Database error:", error.code, error.message, error.details);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Check if any rows were updated
    if (!updated || updated.length === 0) {
      console.error("[PhoneUpdate] No rows updated! User might not exist in user_profiles.");
      // Try to see if user exists at all
      const { data: checkUser } = await admin
        .from("user_profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      
      console.log("[PhoneUpdate] User check result:", checkUser);
      
      return NextResponse.json(
        { error: "User profile not found. Please contact support." },
        { status: 404 }
      );
    }

    const savedPhone = updated[0].phone;
    console.log("[PhoneUpdate] Phone updated successfully! Saved:", savedPhone, "User ID:", updated[0].user_id);

    // Note: Welcome message is now sent via separate /api/user/welcome-message endpoint
    // This prevents duplicate messages

    return NextResponse.json({ success: true, phone: savedPhone });

  } catch (error) {
    console.error("[PhoneUpdate] Exception:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error" },
      { status: 500 }
    );
  }
}
