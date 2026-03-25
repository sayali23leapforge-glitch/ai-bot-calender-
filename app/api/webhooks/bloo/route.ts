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
      webhook_url: "https://ai-bot-calender-qy3c.onrender.com/api/webhooks/bloo",
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

function extractImageUrl(p: Record<string, unknown>): string | null {
  // Check for image attachment in Bloo payload
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
  
  // Check attachments array for image files
  if (Array.isArray(p.attachments)) {
    for (const att of p.attachments) {
      if (att && typeof att === "object") {
        const url = (att as any).url;
        if (typeof url === "string" && url.length > 10) {
          const lowerUrl = url.toLowerCase();
          if (imageExtensions.some(ext => lowerUrl.includes(ext))) {
            console.log("[Webhook] Found image URL in attachments:", url.slice(0, 50) + "...");
            return url;
          }
        }
      }
    }
  }
  return null;
}

function extractAudioUrl(p: Record<string, unknown>): string | null {
  // Check for audio attachment in Bloo payload
  
  // PRIMARY: Check attachments array (Bloo stores URLs here)
  if (Array.isArray(p.attachments)) {
    for (const att of p.attachments) {
      if (att && typeof att === "object") {
        const url = (att as any).url;
        if (typeof url === "string" && url.length > 10 && (url.includes("http") || url.includes("/"))) {
          console.log("[Webhook] Found audio URL in attachments:", url.slice(0, 50) + "...");
          return url;
        }
      }
    }
  }
  
  // FALLBACK: Check other possible fields
  const candidates = [
    p.audio_url, p.voice_url, p.media_url, p.attachment_url,
    (p.media as any)?.url, (p.attachment as any)?.url,
    (p.audio as any)?.url, (p.voice as any)?.url
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 10 && (c.includes("http") || c.includes("/"))) {
      return c;
    }
  }
  return null;
}

// ─── SPEECH-TO-TEXT ───────────────────────────────────────────────────────────
async function transcribeAudio(audioUrl: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("[Webhook] GEMINI_API_KEY not set for transcription");
    return null;
  }

  try {
    // Download audio file
    console.log("[Webhook] Downloading audio from:", audioUrl.slice(0, 50) + "...");
    const audioResponse = await fetch(audioUrl, { signal: AbortSignal.timeout(30000) });
    if (!audioResponse.ok) {
      console.error("[Webhook] Failed to download audio:", audioResponse.status);
      return null;
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    
    // Detect audio type from URL or use default
    const audioMimeType = audioUrl.includes(".ogg") ? "audio/ogg" : 
                        audioUrl.includes(".wav") ? "audio/wav" :
                        audioUrl.includes(".mp3") ? "audio/mpeg" : "audio/ogg";
    
    console.log("[Webhook] Transcribing audio (size: " + (audioBuffer.byteLength / 1024).toFixed(1) + "KB)...");

    // Use Gemini to transcribe audio
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: audioMimeType,
              data: base64Audio,
            },
          },
          {
            text: "Transcribe this audio message exactly. Return ONLY the transcribed text, nothing else."
          }
        ],
      }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.1 },
    });

    const transcription = result.response.text().trim();
    console.log("[Webhook] ✅ Transcribed:", transcription);
    return transcription;

  } catch (e: any) {
    console.error("[Webhook] Transcription error:", e?.message);
    return null;
  }
}

// ─── IMAGE SCANNING ───────────────────────────────────────────────────────────
async function scanImage(imageUrl: string): Promise<{ title: string; description: string; date?: string; time?: string; type?: "task" | "goal" | "event" } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("[Webhook] GEMINI_API_KEY not set for image scanning");
    return null;
  }

  try {
    console.log("[Webhook] 📸 Downloading image from:", imageUrl.slice(0, 50) + "...");
    const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
    if (!imageResponse.ok) {
      console.error("[Webhook] Failed to download image:", imageResponse.status);
      return null;
    }
    
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString("base64");
    
    // Detect image type from URL
    const imageMimeType = imageUrl.toLowerCase().includes(".png") ? "image/png" :
                         imageUrl.toLowerCase().includes(".gif") ? "image/gif" :
                         imageUrl.toLowerCase().includes(".webp") ? "image/webp" :
                         imageUrl.toLowerCase().includes(".bmp") ? "image/bmp" :
                         "image/jpeg";
    
    console.log("[Webhook] 📸 Scanning image (size: " + (imageBuffer.byteLength / 1024).toFixed(1) + "KB, type: " + imageMimeType + ")...");

    // Use Gemini Vision to extract event/task/goal details
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: imageMimeType,
              data: base64Image,
            },
          },
          {
            text: `Analyze this image and extract event/task/goal details. Return ONLY valid JSON, no markdown, no explanation.

CRITICAL INSTRUCTIONS:
1. Look for text fields like "EVENT NAME HERE", "Title:", "Task:", "Goal:" - use EXACTLY what you see
2. For times like "10:00 AM - 12:00 PM" or "10:00 AM - 12:00 PM", extract ONLY the START time (10:00)
3. For dates, look for explicit dates mentioned (e.g., "26 March 2026") and convert to YYYY-MM-DD
4. If you see a calendared event/task/goal, it's type="event" for scheduled items, type="task" for action items, type="goal" for habits
5. Extract the actual visible text, not generic placeholders

JSON format (MUST be valid JSON):
{"title":"exact title from image","description":"brief description","date":"YYYY-MM-DD or null","time":"HH:MM or null","type":"event|task|goal"}

Return ONLY the JSON object, nothing else - no markdown, no extra text.`
          }
        ],
      }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.1 },
    });

    const rawText = result.response.text().trim().replace(/```json|```/g, "").trim();
    const analyzed = JSON.parse(rawText);
    console.log("[Webhook] 📸 Image analysis:", analyzed);
    return analyzed;

  } catch (e: any) {
    console.error("[Webhook] Image scanning error:", e?.message);
    return null;
  }
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
  
  // CONVERSATIONAL: Questions, greetings, acknowledgments
  if (/^(hi|hey|hello|thanks|thanx|ok|okay|cool|good|yeah|sure|yes|no|right|lol|haha|awesome|nice)$/i.test(lower)
    || /\?$/.test(lower.trim())  // Ends with ? → question
    || /\b(how are you|how are you doing|what's up|sup|yo|what's new|how's it|tell me|what time|what date|hello there|hey there)\b/i.test(lower)) {
    return { type: null, title: text, date: null, time: null };  // Conversational
  }
  
  // Extract date/time FIRST (before type classification)
  let date: string | null = null;
  if (lower.includes("tomorrow")) date = tomorrow;
  else if (lower.includes("today")) date = today;
  else if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower)) {
    // For weekdays, default to nearest future date (simplified - just use today for now)
    date = today;  // TODO: Calculate next occurrence of that weekday
  }
  
  let time: string | null = null;
  // Try multiple time patterns: "2 pm", "2pm", "2 p.m.", "14:00", "2:30 pm", "at 2"
  let tmMatch = lower.match(/(?:at\s+)?(\d{1,2}):(\d{2})\s*(?:p\.m\.|pm|a\.m\.|am)?/i);  // HH:MM format with optional am/pm
  if (!tmMatch) {
    tmMatch = lower.match(/(?:at\s+)?(\d{1,2})\s*(?::(\d{2}))?\s*(?:p\.m\.|pm|a\.m\.|am)/i);  // H AM/PM or HH:MM AM/PM
  }
  if (!tmMatch && /(?:at\s+)?\d{1,2}(?!\d)/.test(lower)) {
    // Try matching just a number "at 2" or "2" (without am/pm, assume PM)
    const numMatch = lower.match(/(?:at\s+)?(\d{1,2})(?!\d)/);
    if (numMatch) {
      const h = parseInt(numMatch[1]);
      // If hour is 1-11, assume PM; if 12, assume AM; if 0-23, use as-is
      const finalH = (h >= 1 && h <= 11) ? h + 12 : h;
      time = `${String(finalH).padStart(2, "0")}:00`;
      tmMatch = null; // Mark as matched to skip below
    }
  }
  
  if (tmMatch && tmMatch.length >= 1) {
    let h = parseInt(tmMatch[1]);
    const m = tmMatch[2] ? parseInt(tmMatch[2]) : 0;
    let period = tmMatch[3] ? tmMatch[3].toLowerCase() : "";
    
    // Normalize period: convert "p.m." → "pm", "a.m." → "am"
    period = period.replace(/\./g, "");
    
    // Convert to 24-hour format if AM/PM specified
    if (period) {
      if ((period === "pm" || period === "p") && h !== 12) h += 12;
      if ((period === "am" || period === "a") && h === 12) h = 0;
    }
    time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  
  // Now classify intent type
  const isGoal = /\b(learn|study|master|improve|practice|habit|daily|every day|each day|consistently)\b/.test(lower);
  const isEvent = /\b(meeting|appointment|dentist|doctor|lunch|dinner|call with|schedule|book|reserve|reschedule|plan|arrange|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)
    || /\d{1,2}:\d{2}|\d\s*(am|pm)/.test(lower);
  const isTask = /\b(buy|get|purchase|send|call|email|message|write|create|make|fix|repair|clean|cook|do|check|review|complete|finish|start|begin|try|build|process|handle|organize|prepare|setup)\b/i.test(lower);
  
  let type: Intent["type"] = null;  // DEFAULT: conversational
  if (isGoal && !isEvent) {
    type = "goal";
  } else if (isEvent) {
    type = "event";  // EVENT: has event keywords or is scheduled for a specific time
  } else if (isTask) {
    type = "task";   // TASK: has action keywords but no event/goal keywords
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
    console.log("[Webhook] Full payload:", JSON.stringify(payload, null, 2).slice(0, 2000));

    // 4. Extract fields - Try text first, then voice, then image
    let text = extractText(payload);
    const senderPhone = extractSenderPhone(payload);  // external_id → reply TO this
    const blooNumber = extractBlooNumber(payload);    // internal_id → identifies WHICH user
    let audioUrl: string | null = null;
    let imageUrl: string | null = null;
    let imageData: { title: string; description: string; date?: string; time?: string; type?: "task" | "goal" | "event" } | null = null;

    // If no text, check for audio URL and transcribe IMMEDIATELY (synchronous)
    if (!text) {
      audioUrl = extractAudioUrl(payload);
      if (audioUrl) {
        console.log("[Webhook] 🎙️ Voice message detected, transcribing now...");
        text = await transcribeAudio(audioUrl);
        if (text) {
          console.log("[Webhook] 🎙️ Voice → Text: " + text);
        }
      }
    }

    // If still no text, check for image and scan it
    if (!text) {
      imageUrl = extractImageUrl(payload);
      if (imageUrl) {
        console.log("[Webhook] 📸 Image detected, scanning now...");
        imageData = await scanImage(imageUrl);
        if (imageData && imageData.title) {
          text = imageData.title;
          console.log("[Webhook] 📸 Image scanned → Title: " + text);
        }
      }
    }

    // Log what we found
    console.log("[Webhook] text:", text ?? "(no text/voice/image)");
    console.log("[Webhook] senderPhone:", senderPhone, "| blooNumber:", blooNumber);

    if (!text || !senderPhone) {
      console.log("[Webhook] Missing text/voice or sender → skip");
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
    // ┌─ USER PROFILE LOOKUP (Multi-User Shared Bloo Support) ─┐
    // │                                                         │
    // │ Scenario: Multiple users share the SAME Bloo number   │
    // │ Each user has a DIFFERENT personal phone               │
    // │                                                         │
    // │ Bloo payload contains:                               │
    // │  - external_id = sender's personal phone number       │
    // │  - internal_id = shared Bloo bound number             │
    // │                                                         │
    // │ MATCHING PRIORITY (for shared Bloo):                  │
    // │  1. PRIMARY: Match external_id with phone             │
    // │     (WHO sent the message → correct user account)     │
    // │  2. FALLBACK: Match internal_id with bloo_bound_num   │
    // │     (if phone not registered yet)                     │
    // │                                                         │
    // │ Example: 3 users, 1 Bloo number                       │
    // │  User 1: +8090995623  ) ──┐                           │
    // │  User 2: +8080603212  ) ── Shared: +16267423142       │
    // │  User 3: +9920261793  ) ──┘                           │
    // │                                                         │
    // │ Message from User 2 → Task created in User 2 account  │
    // └─────────────────────────────────────────────────────────┘
    const admin = getSupabaseAdminClient();
    const { data: allProfiles, error: dbErr } = await admin
      .from("user_profiles")
      .select("user_id, phone, bloo_bound_number");

    if (dbErr) {
      console.error("[Webhook] DB error:", dbErr.message);
      sendBloo(replyTo, "⚠️ Oops! I'm having trouble connecting. Please try again in a moment! 🔄", blooNumber).catch(e => console.error("[Webhook] Send error:", e?.message));
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    console.log(`[Webhook] Searching ${allProfiles?.length ?? 0} profiles | blooNumber=${blooNumber} | senderPhone=${senderPhone}`);

    let userId: string | null = null;

    // PRIMARY MATCH: Try to find user by SENDER'S PHONE (external_id from Bloo)
    // This is critical for multi-user shared Bloo: match by WHO SENT the message
    if (senderPhone && allProfiles) {
      const normSender = normalizePhone(senderPhone);
      for (const p of allProfiles) {
        if (p.phone && phonesMatch(normSender, p.phone)) {
          userId = p.user_id;
          console.log(`[Webhook] ✅ PRIMARY MATCH: phone "${p.phone}" → user ${p.user_id}`);
          break;
        }
      }
    }

    // FALLBACK MATCH: If no phone match, try to find user by Bloo bound number (internal_id from Bloo)
    // This catches users who may not have registered their phone number yet
    if (!userId && blooNumber && allProfiles) {
      const normBloo = normalizePhone(blooNumber);
      for (const p of allProfiles) {
        if (p.bloo_bound_number && phonesMatch(normBloo, p.bloo_bound_number)) {
          userId = p.user_id;
          console.log(`[Webhook] ✅ FALLBACK MATCH: bloo_bound_number "${p.bloo_bound_number}" → user ${p.user_id}`);
          break;
        }
      }
    }

    if (!userId) {
      console.log("[Webhook] ❌ No user found for blooNumber:", blooNumber, "senderPhone:", senderPhone);
      console.log("[Webhook] All bloo_bound_numbers:", allProfiles?.map((p: any) => p.bloo_bound_number));
      console.log("[Webhook] All phones:", allProfiles?.map((p: any) => p.phone));
      await sendBloo(
        replyTo,
        "👋 Hi! I'm Cal, your calendar assistant. 📱\n\nI couldn't recognize your account. Please:\n\n1. Open the Calendar app\n2. Go to Settings ⚙️\n3. Save your:\n   📞 Personal phone: +919920261793\n   📲 Bloo bound number: +1(626)742-3142\n\nThen message me again and I'll create tasks, events, and goals for you! 🚀",
        blooNumber
      );
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 6. Quick intent for fast response
    const quickIntent = fallbackIntent(text);
    console.log("[Webhook] Quick Intent (fallback):", JSON.stringify(quickIntent));

    // Determine source (already extracted audioUrl/imageUrl above)
    const source = imageUrl ? "📸 iMessage Image" : audioUrl ? "🎙️ iMessage Voice" : "📱 iMessage Text";

    // 7. CREATE DB ENTRY FIRST (verify it works before sending confirmation)
    let dbSuccess = false;
    let dbError = "";

    // Merge image data into intent if available
    let finalIntent = { ...quickIntent };
    let finalDescription = `${source}: "${text.slice(0, 80)}"`;
    
    if (imageData) {
      // Prefer image title if it looks like a real event/task title (longer, not just user command)
      if (imageData.title && imageData.title.length > 5 && !imageData.title.toLowerCase().includes("schedule")) {
        finalIntent.title = imageData.title;
      }
      // Use image type if detected
      if (imageData.type) finalIntent.type = imageData.type;
      // Use image dates/times if available
      if (imageData.date) finalIntent.date = imageData.date;
      if (imageData.time) finalIntent.time = imageData.time;
      if (imageData.description) finalDescription = `${source}: ${imageData.description}`;
    }

    try {
      if (quickIntent.type === "task") {
        const listId = await getOrCreateTaskList(admin, userId);
        if (!listId) {
          dbError = "Could not create task list";
        } else {
          const { error } = await admin.from("tasks").insert({
            user_id: userId, list_id: listId,
            title: finalIntent.title.slice(0, 200),
            notes: finalDescription,
            due_date: finalIntent.date ?? null,
            due_time: finalIntent.time ?? null,
            is_completed: false, is_starred: false,
            position: 0, priority: "medium", progress: 0,
          });
          if (error) {
            dbError = error.message;
          } else {
            dbSuccess = true;
            console.log("[Webhook] ✅ Task inserted to DB");
          }
        }
      } else if (finalIntent.type === "goal") {
        const { error } = await admin.from("goals").insert({
          user_id: userId,
          title: finalIntent.title.slice(0, 200),
          description: finalDescription,
          category: "personal", priority: "medium",
          progress: 0, target_date: finalIntent.date ?? null,
        });
        if (error) {
          dbError = error.message;
        } else {
          dbSuccess = true;
          console.log("[Webhook] ✅ Goal inserted to DB");
        }
      } else if (finalIntent.type === "event") {
        if (finalIntent.date) {
          const { error } = await admin.from("calendar_events").insert({
            user_id: userId,
            title: finalIntent.title.slice(0, 200),
            description: finalDescription,
            event_date: finalIntent.date,
            start_time: finalIntent.time ?? null,
            is_completed: false, category: "other", priority: "medium",
          });
          if (error) {
            dbError = error.message;
          } else {
            dbSuccess = true;
            console.log("[Webhook] ✅ Event inserted to DB");
          }
        } else {
          const listId = await getOrCreateTaskList(admin, userId);
          if (!listId) {
            dbError = "Could not create task list";
          } else {
            const { error } = await admin.from("tasks").insert({
              user_id: userId, list_id: listId, title: finalIntent.title.slice(0, 200), notes: finalDescription,
              due_time: finalIntent.time ?? null, is_completed: false, is_starred: false, position: 0, priority: "medium", progress: 0
            });
            if (error) {
              dbError = error.message;
            } else {
              dbSuccess = true;
              console.log("[Webhook] ✅ Task (no date) inserted to DB");
            }
          }
        }
      } else {
        // Conversational - no DB needed
        dbSuccess = true;
      }
    } catch (err: any) {
      dbError = err?.message || "Unknown error";
      console.error("[Webhook] DB operation error:", dbError);
    }

    // 8. SEND RESPONSE BASED ON DB SUCCESS (await these so confirmation is sent before webhook returns)
    if (finalIntent.type === "task" && dbSuccess) {
      await sendBloo(replyTo, `✅ Task created: "${finalIntent.title}"`, blooNumber);
    } else if (finalIntent.type === "goal" && dbSuccess) {
      await sendBloo(replyTo, `🎯 Goal set: "${finalIntent.title}"`, blooNumber);
    } else if (finalIntent.type === "event" && dbSuccess) {
      if (finalIntent.date) {
        const dateStr = finalIntent.time ? `${finalIntent.date} at ${finalIntent.time}` : finalIntent.date;
        await sendBloo(replyTo, `📅 Event added: "${finalIntent.title}" — ${dateStr}`, blooNumber);
      } else {
        await sendBloo(replyTo, `✅ Added: "${finalIntent.title}" (include a date like "tomorrow" or "Friday" to create a calendar event)`, blooNumber);
      }
    } else if (dbError) {
      // DB failed - send error
      await sendBloo(replyTo, `❌ Error: ${dbError.slice(0, 60)}. Please try again.`, blooNumber);
    } else {
      // Conversational response - no DB involved
      const fallbackReply = "Hey there! 👋 I'm Cal, your calendar assistant! 📱\n\n😊 I'm doing great, thanks for asking!\n\nWhat would you like to create today?\n\n📝 **TASK** - \"Buy groceries\" or \"Call mom\"\n📅 **EVENT** - \"Meeting tomorrow at 2pm\" or \"Dinner Friday 7pm\"\n🎯 **GOAL** - \"Learn guitar daily\" or \"Exercise 3x week\"\n\nOr just chat with me! 💬";
      await sendBloo(replyTo, fallbackReply, blooNumber);
    }

    // 9. BACKGROUND: Refine with Gemini if needed (doesn't block response)
    (async () => {
      try {
        if (finalIntent.type === null) {
          // Conversational - get AI response in background
          const apiKey = process.env.GEMINI_API_KEY;
          if (apiKey) {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const res = await model.generateContent({
              contents: [{
                role: "user",
                parts: [{
                  text: `You are Cal, a friendly calendar AI assistant. Users message you to create tasks, events, and goals.

RESPONSE RULES:
1. Always respond warmly with emojis 😊
2. For greetings ("hey", "hi", "hello", "how are you"), respond cheerfully then offer to help
3. ALWAYS show 3 options with emojis:
   📝 TASK - quick action items
   📅 EVENT - scheduled meetings or appointments  
   🎯 GOAL - habits or learning goals
4. Give specific examples for each type
5. Keep it friendly and approachable
6. Use multiple lines and emojis generously

User said: "${text}"

Generate a 4-6 line friendly response with examples for each type!`
                }]
              }],
              generationConfig: { maxOutputTokens: 150, temperature: 0.8 },
            });
            const r = res.response.text().trim();
            if (r && r.length > 30) {
              // Send improved conversational response
              sendBloo(replyTo, r, blooNumber);
            }
          }
        }
      } catch (err: any) {
        console.error("[Webhook] Background Gemini error:", err?.message);
      }
    })();

    console.log("[Webhook] ======== DONE (response sent) ========\n");
    return NextResponse.json({ ok: true }, { status: 200 });

  } catch (err: any) {
    console.error("[Webhook] ❌ Unhandled exception:", err?.message);
    console.error("[Webhook] Stack:", err?.stack);
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

