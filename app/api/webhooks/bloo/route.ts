import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin
      .from("user_profiles")
      .select("user_id, bloo_bound_number, phone")
      .limit(20);
    return NextResponse.json({
      ok: true,
      webhook_url: "https://ai-bot-calender-uhzp.onrender.com/api/webhooks/bloo",
      bloo_api_key: !!process.env.BLOO_API_KEY ? "set" : "MISSING",
      gemini_api_key: !!process.env.GEMINI_API_KEY ? "set" : "MISSING",
      db_connected: !error,
      db_error: error?.message ?? null,
      user_count: data?.length ?? 0,
      users_with_bloo: data?.filter((u: any) => u.bloo_bound_number).length ?? 0,
      users_with_phone: data?.filter((u: any) => u.phone).length ?? 0,
      profiles: data?.map((u: any) => ({
        user_id: u.user_id?.slice(0, 8),
        bloo_bound_number: u.bloo_bound_number ?? null,
        phone: u.phone ? u.phone.slice(0, 4) + "***" : null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

function normalizePhone(raw: string): string {
  // Normalize phone to +<digits> format for consistent API calls
  // Handles: " +1 (626) 742-3142 ", "+1(626)742-3142", "6267423142", etc.
  const cleaned = raw.replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return "+" + digitsOnly(cleaned);
  const digits = digitsOnly(cleaned);
  if (digits.length >= 11) return "+" + digits;  // Assume already has country code
  if (digits.length === 10) return "+1" + digits;  // US number without country code
  return "+" + digits;  // Fallback
}

function phonesMatch(a: string, b: string): boolean {
  // Compare two phone numbers flexibly - handles different formats:
  // +1234567890, 1234567890, (123) 456-7890, +1 (626) 742-3142, etc.
  // All normalized to digit comparison (full comparison + last 10 digits fallback)
  if (!a || !b) return false;
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da === db) return true;  // Exact digit match
  const la = da.slice(-10);    // Last 10 digits
  const lb = db.slice(-10);
  return la.length === 10 && la === lb;  // Fallback: last 10 digits match
}

function getTodayTomorrow() {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  return { today: fmt(now), tomorrow: fmt(tmr) };
}

function extractText(p: Record<string, unknown>): string | null {
  const raw = p.text ?? p.message ?? p.body ?? p.content ?? null;
  if (!raw || typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return s.length ? s : null;
}

function extractSenderPhone(p: Record<string, unknown>): string | null {
  const candidates = [p.external_id, p.phone, p.sender, p.from, p.phoneNumber, p.from_number];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 4) return c;
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const inner = o.address ?? o.phoneNumber ?? o.phone ?? o.handle ?? o.number;
      if (typeof inner === "string" && inner.length > 4) return inner as string;
    }
  }
  return null;
}

function extractBlooNumber(p: Record<string, unknown>): string | null {
  const candidates = [p.internal_id, p.channel_id, p.to, p.toNumber, p.recipient];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 4) return c;
  }
  return null;
}

// ─── AI INTENT ────────────────────────────────────────────────────────────────
type Intent = { type: "task" | "goal" | "event" | null; title: string; date: string | null; time: string | null };

async function analyzeIntent(text: string): Promise<Intent> {
  const { today, tomorrow } = getTodayTomorrow();
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const result = await model.generateContent({
        contents: [{
          role: "user",
          parts: [{
            text: `Classify this message. Return ONLY valid JSON, no markdown, no extra text.\n\nMessage: "${text}"\n\nJSON format:\n{"type":"task","title":"concise title","date":null,"time":null}\n\ntype values:\n- "task" = action to do (buy anything, call someone, fix something, any todo)\n- "goal" = habit or learning (learn piano, exercise daily, lose weight)\n- "event" = specific date/time meeting (meeting tomorrow 3pm, dentist Friday)\n- null = pure conversation/question (hi, how are you, what time is it)\n\nToday=${today}, Tomorrow=${tomorrow}`
          }]
        }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.1 },
      });
      const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
      console.log("[Webhook] Gemini raw:", raw);
      const parsed = JSON.parse(raw);
      return {
        type: parsed.type ?? null,
        title: String(parsed.title ?? text).trim(),
        date: parsed.date ?? null,
        time: parsed.time ?? null,
      };
    } catch (e: any) {
      console.log("[Webhook] Gemini failed:", e?.message);
    }
  }
  return fallbackIntent(text);
}

function fallbackIntent(text: string): Intent {
  const { today, tomorrow } = getTodayTomorrow();
  const lower = text.toLowerCase().trim();
  
  // Very short casual messages (hi, hey, hello, thanks, etc) → conversational
  if (text.length <= 20 && /^(hi|hey|hello|thanks|thanx|ok|okay|cool|good|sure|yes|no|right|lol|haha)$/i.test(text.trim())) {
    return { type: null, title: text, date: null, time: null };
  }
  
  const isGoal = /\b(learn|study|master|improve|practice|habit|daily|every day|each day|consistently)\b/.test(lower);
  const isEvent = /\b(meeting|appointment|dentist|doctor|lunch|dinner|call with|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)
    || /\d{1,2}:\d{2}|\d\s*(am|pm)/.test(lower);
  let type: Intent["type"] = "task";
  if (isGoal && !isEvent) type = "goal";
  else if (isEvent) type = "event";
  let date: string | null = null;
  if (lower.includes("tomorrow")) date = tomorrow;
  else if (lower.includes("today")) date = today;
  let time: string | null = null;
  const tm = lower.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/);
  if (tm) {
    let h = parseInt(tm[1]);
    const m = tm[2] ? parseInt(tm[2]) : 0;
    if (tm[3] === "pm" && h !== 12) h += 12;
    if (tm[3] === "am" && h === 12) h = 0;
    time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return { type, title: text.trim(), date, time };
}

// ─── SEND BLOO ────────────────────────────────────────────────────────────────
async function sendBloo(toPhone: string, message: string, fromBlooNumber?: string | null): Promise<void> {
  const key = process.env.BLOO_API_KEY;
  if (!key) { console.log("[Webhook] BLOO_API_KEY not set — cannot send reply"); return; }
  const phone = normalizePhone(toPhone);
  console.log(`[Webhook] SEND→${phone} (from=${fromBlooNumber ?? 'default'}): "${message.slice(0, 80)}"`);
  try {
    // Include the sending number so Bloo knows which channel/device to use
    const payload: Record<string, string> = { text: message };
    if (fromBlooNumber) {
      payload.number = normalizePhone(fromBlooNumber);
    }
    const res = await fetch(
      `https://backend.blooio.com/v2/api/chats/${encodeURIComponent(phone)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      }
    );
    const body = await res.text();
    console.log(`[Webhook] Bloo API ${res.status}: ${body.slice(0, 300)}`);
  } catch (e: any) {
    console.error("[Webhook] Bloo send error:", e?.message);
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function getOrCreateTaskList(admin: any, userId: string): Promise<string | null> {
  const { data: lists } = await admin.from("task_lists").select("id").eq("user_id", userId).limit(1);
  if (lists?.length) return lists[0].id;
  const { data: nl, error } = await admin.from("task_lists")
    .insert({ user_id: userId, name: "My Tasks", color: "#3b82f6", is_visible: true, position: 0 })
    .select("id").single();
  if (error) { console.error("[Webhook] create list error:", error.message); return null; }
  return nl?.id ?? null;
}

// ─── MAIN POST HANDLER ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {

  try {
    // 1. Read body
    let rawBody = "";
    try { rawBody = await req.text(); } catch (e: any) {
      console.error("[Webhook] Read body error:", e?.message);
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    if (!rawBody.trim()) return NextResponse.json({ ok: true }, { status: 200 });

    // 2. Parse JSON
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(rawBody); } catch {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 3. Only process inbound user messages — silently skip everything else
    const event = String(payload.event ?? "").toLowerCase();
    if (event !== "message.received") {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    console.log("[Webhook] ======== INCOMING", new Date().toISOString(), "========");
    console.log("[Webhook] event:", payload.event, "| keys:", Object.keys(payload).join(", "));

    // 4. Extract fields
    const text = extractText(payload);
    const senderPhone = extractSenderPhone(payload);  // external_id → reply TO this
    const blooNumber = extractBlooNumber(payload);    // internal_id → identifies WHICH user

    console.log("[Webhook] text:", text);
    console.log("[Webhook] senderPhone:", senderPhone, "| blooNumber:", blooNumber);

    if (!text || !senderPhone) {
      console.log("[Webhook] Missing text or sender → skip");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // Guard: skip our own bot reply messages (extra safety against loops)
    const BOT_PREFIXES = ["✅ Task created:", "🎯 Goal set:", "📅 Event added:", "✅ Added:", "⚠️", "❌", "👋 Hi! I received"];
    if (BOT_PREFIXES.some(p => text.startsWith(p))) {
      console.log("[Webhook] Skip — looks like a bot reply, not a user message");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const replyTo = senderPhone;  // Send reply back to the personal phone number

    // 5. Find user
    // ┌─ USER PROFILE LOOKUP (Works for ANY user with ANY phone numbers) ─┐
    // │                                                                    │
    // │ Bloo payload contains:                                           │
    // │  - external_id = personal phone that sent message                │
    // │  - internal_id = Bloo bound number message was sent TO           │
    // │                                                                    │
    // │ Profile database contains:                                       │
    // │  - phone = personal phone number user registered                 │
    // │  - bloo_bound_number = Bloo number user registered               │
    // │                                                                    │
    // │ MATCHING STRATEGY:                                               │
    // │  1. PRIMARY: Match internal_id with bloo_bound_number            │
    // │     (most reliable — Bloo number is unique per device)           │
    // │  2. FALLBACK: Match external_id with phone                       │
    // │     (if no Bloo match, try personal phone)                       │
    // │  3. If still no match: Tell user to update settings              │
    // │                                                                    │
    // └────────────────────────────────────────────────────────────────────┘
    const admin = getSupabaseAdminClient();
    const { data: allProfiles, error: dbErr } = await admin
      .from("user_profiles")
      .select("user_id, phone, bloo_bound_number");

    if (dbErr) {
      console.error("[Webhook] DB error:", dbErr.message);
      await sendBloo(replyTo, "⚠️ System error. Please try again shortly.");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    console.log(`[Webhook] Searching ${allProfiles?.length ?? 0} profiles | blooNumber=${blooNumber} | senderPhone=${senderPhone}`);

    let userId: string | null = null;

    // PRIMARY MATCH: Try to find user by Bloo bound number (internal_id from Bloo)
    // This is the most reliable match because each Bloo device/channel has one bound number
    if (blooNumber && allProfiles) {
      const normBloo = normalizePhone(blooNumber);
      for (const p of allProfiles) {
        if (p.bloo_bound_number && phonesMatch(normBloo, p.bloo_bound_number)) {
          userId = p.user_id;
          console.log(`[Webhook] ✅ PRIMARY MATCH: bloo_bound_number "${p.bloo_bound_number}" → user ${p.user_id}`);
          break;
        }
      }
    }

    // FALLBACK MATCH: If no Bloo match, try to find user by personal phone (external_id from Bloo)
    // This catches users who may not have registered their Bloo number yet
    if (!userId && allProfiles) {
      const normSender = normalizePhone(senderPhone);
      for (const p of allProfiles) {
        if (p.phone && phonesMatch(normSender, p.phone)) {
          userId = p.user_id;
          console.log(`[Webhook] ✅ FALLBACK MATCH: phone "${p.phone}" → user ${p.user_id}`);
          break;
        }
      }
    }

    if (!userId) {
      console.log("[Webhook] ❌ No user found for blooNumber:", blooNumber, "senderPhone:", senderPhone);
      console.log("[Webhook] All bloo_bound_numbers:", allProfiles?.map((p: any) => p.bloo_bound_number));
      console.log("[Webhook] All phones:", allProfiles?.map((p: any) => p.phone));
      sendBloo(
        replyTo,
        "👋 Hi! I received your message but couldn't link it to an account.\n\nFix: Open the app → Settings → save your phone number and Bloo number (+1(626)742-3142). Then try again!",
        blooNumber
      ).catch(e => console.error("[Webhook] Send error:", e?.message));
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 6. Analyze intent
    const intent = await analyzeIntent(text);
    console.log("[Webhook] Intent:", JSON.stringify(intent));

    // 7. Create entry and reply
    if (intent.type === "task") {
      const listId = await getOrCreateTaskList(admin, userId);
      if (!listId) {
        await sendBloo(replyTo, "❌ Couldn't create task list. Please check the app.", blooNumber);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      const { error } = await admin.from("tasks").insert({
        user_id: userId, list_id: listId,
        title: intent.title.slice(0, 200),
        notes: `Via iMessage: "${text.slice(0, 300)}"`,
        due_date: intent.date ?? null,
        due_time: intent.time ?? null,
        is_completed: false, is_starred: false,
        position: 0, priority: "medium", progress: 0,
      });
      if (error) {
        console.error("[Webhook] task insert error:", error.message);
        sendBloo(replyTo, `❌ Error saving task: ${error.message.slice(0, 80)}`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
      } else {
        console.log("[Webhook] ✅ Task:", intent.title);
        sendBloo(replyTo, `✅ Task created: "${intent.title}"`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
      }

    } else if (intent.type === "goal") {
      const { error } = await admin.from("goals").insert({
        user_id: userId,
        title: intent.title.slice(0, 200),
        description: `Via iMessage: "${text.slice(0, 300)}"`,
        category: "personal", priority: "medium",
        progress: 0, target_date: intent.date ?? null,
      });
      if (error) {
        console.error("[Webhook] goal insert error:", error.message);
        sendBloo(replyTo, `❌ Error saving goal: ${error.message.slice(0, 80)}`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
      } else {
        console.log("[Webhook] ✅ Goal:", intent.title);
        sendBloo(replyTo, `🎯 Goal set: "${intent.title}"`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
      }

    } else if (intent.type === "event") {
      if (!intent.date) {
        // No date → save as task
        const listId = await getOrCreateTaskList(admin, userId);
        if (listId) {
          await admin.from("tasks").insert({ user_id: userId, list_id: listId, title: intent.title.slice(0, 200), notes: `Via iMessage`, due_time: intent.time ?? null, is_completed: false, is_starred: false, position: 0, priority: "medium", progress: 0 });
        }
        sendBloo(replyTo, `✅ Added: "${intent.title}" (include a date like "tomorrow" or "Friday" to create a calendar event)`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
      } else {
        const { error } = await admin.from("calendar_events").insert({
          user_id: userId,
          title: intent.title.slice(0, 200),
          description: `Via iMessage: "${text.slice(0, 300)}"`,
          event_date: intent.date,
          start_time: intent.time ?? null,
          is_completed: false, category: "other", priority: "medium",
        });
        if (error) {
          console.error("[Webhook] event insert error:", error.message);
          sendBloo(replyTo, `❌ Error saving event: ${error.message.slice(0, 80)}`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
        } else {
          const dateStr = intent.time ? `${intent.date} at ${intent.time}` : intent.date;
          console.log("[Webhook] ✅ Event:", intent.title);
          sendBloo(replyTo, `📅 Event added: "${intent.title}" — ${dateStr}`, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
        }
      }

    } else {
      // Conversational / null
      let reply = "Hi! 👋 What would you like to create?\n• \"Buy milk\" → task\n• \"Meeting tomorrow 3pm\" → event\n• \"Learn piano daily\" → goal\n\nOr just chat with me!";
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        try {
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const res = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `You are a friendly calendar assistant AI. Reply in 1-2 sentences to: "${text}"` }] }],
            generationConfig: { maxOutputTokens: 80, temperature: 0.7 },
          });
          const r = res.response.text().trim();
          if (r) reply = r;
        } catch (e: any) {
          console.log("[Webhook] conversational Gemini failed:", e?.message);
        }
      }
      sendBloo(replyTo, reply, blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
    }

    console.log("[Webhook] ======== DONE ========\n");
    return NextResponse.json({ ok: true }, { status: 200 });

  } catch (err: any) {
    console.error("[Webhook] ❌ Unhandled exception:", err?.message);
    console.error("[Webhook] Stack:", err?.stack);
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

