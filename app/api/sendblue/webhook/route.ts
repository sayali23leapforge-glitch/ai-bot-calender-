import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export const runtime = "nodejs"; // safer for reading request bodies + logging

type BlooPayload = {
  event?: string;
  status?: string;
  message_id?: string;
  external_id?: string;
  protocol?: string;
  timestamp?: number;
  internal_id?: string;
  is_group?: boolean;
  text?: string;
  sent_at?: number;
  message?: string;
  body?: string;
  phone?: unknown;
  sender?: unknown;
  from?: unknown;
  phoneNumber?: unknown;
  conversationId?: string;
  chatId?: string;
  [key: string]: unknown;
};

function safeEqual(a?: string | null, b?: string | null) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function normalizePhone(phoneInput: string): string {
  console.log(`[BlooWebhook] Normalizing phone: ${phoneInput}`);
  let cleaned = phoneInput
    .replace(/\s+/g, "")
    .replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) {
    const normalized = "+" + cleaned.slice(1).replace(/\D/g, "");
    console.log(`[BlooWebhook] Already prefixed: ${normalized}`);
    return normalized;
  }

  cleaned = cleaned.replace(/\+/g, "");

  if (cleaned.length === 10) {
    const result = "+91" + cleaned;
    console.log(`[BlooWebhook] 10-digit Indian: ${result}`);
    return result;
  }

  if (cleaned.length === 11 && cleaned.startsWith("1")) {
    const result = "+" + cleaned;
    console.log(`[BlooWebhook] 11-digit US: ${result}`);
    return result;
  }

  if (cleaned.length === 12 && cleaned.startsWith("91")) {
    const result = "+" + cleaned;
    console.log(`[BlooWebhook] 12-digit Indian: ${result}`);
    return result;
  }

  if (cleaned.length > 10) {
    const result = "+" + cleaned;
    console.log(`[BlooWebhook] Custom format: ${result}`);
    return result;
  }

  const result = "+91" + cleaned;
  console.log(`[BlooWebhook] Fallback (short): ${result}`);
  return result;
}

function extractText(payload: BlooPayload): string | null {
  // Try multiple field names: text, message, body
  const raw = payload.text ?? payload.message ?? payload.body ?? null;
  if (!raw || typeof raw !== "string") {
    console.log("[BlooWebhook] No message text found");
    return null;
  }

  const sanitized = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized.length ? sanitized : null;
}

function extractSenderPhone(payload: BlooPayload): string | null {
  console.log("[BlooWebhook] Attempting to extract phone...");
  console.log("[BlooWebhook] Payload keys:", Object.keys(payload));

  // For Bloo: external_id = sender's phone (who sent us the message)
  const candidates: unknown[] = [
    payload.external_id,
    payload.phone,
    payload.sender,
    payload.from,
    payload.phoneNumber,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;

    if (typeof candidate === "string") {
      console.log(`[BlooWebhook] Found phone (string): ${candidate}`);
      return candidate;
    }

    if (typeof candidate === "object") {
      const obj = candidate as Record<string, unknown>;
      const phone =
        obj.address || obj.phoneNumber || obj.phone || obj.handle || obj.from;

      if (typeof phone === "string") {
        console.log(`[BlooWebhook] Found phone (object): ${phone}`);
        return phone;
      }
    }
  }

  console.log("[BlooWebhook] No sender phone found");
  return null;
}

async function analyzeMessageWithAI(text: string): Promise<{ type: "task" | "goal" | "event" | null; title: string; date: string | null; time?: string | null }> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log("[BlooWebhook] Gemini API key not configured");
      return fallbackParseIntent(text);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `Analyze this message and determine user intent.
Message: "${text}"

Return ONLY valid JSON:
{
  "type": "task" | "goal" | "event" | null,
  "title": "cleaned action",
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null
}

Rules:
- TASK: Simple actions without scheduling (buy milk, call mom, do homework)
- GOAL: Learning/improving/habits (learn coding, run daily, get fit)
- EVENT: Scheduled/dated items (meeting tomorrow, lunch Friday 2pm)
- TODAY: 2026-03-18, TOMORROW: 2026-03-19`;

    console.log("[BlooWebhook] Calling Gemini API...");
    const response = await model.generateContent(prompt);
    const responseText = response.response.text().trim();

    try {
      const result = JSON.parse(responseText);
      console.log("[BlooWebhook] AI Analysis:", result);
      return result;
    } catch (e) {
      console.log("[BlooWebhook] Failed to parse:", responseText);
      return fallbackParseIntent(text);
    }
  } catch (error) {
    console.log("[BlooWebhook] AI error, using fallback:", error);
    return fallbackParseIntent(text);
  }
}

function fallbackParseIntent(text: string): { type: "task" | "goal" | "event" | null; title: string; date: string | null; time?: string | null } {
  const lower = text.toLowerCase().trim();

  // Detect goal/learning keywords
  const isGoal = /\b(learn|study|master|improve|practice|build habit)\b/.test(lower);

  // Detect event/scheduling keywords
  const isEvent =
    /\b(meeting|schedule|tomorrow|today|friday|monday|tuesday|at \d|pm|am)\b/.test(lower) ||
    /\d{1,2}:\d{2}|[0-9]{1,2}\s*(am|pm)/.test(lower);

  let type: "task" | "goal" | "event" | null = "task";
  if (isGoal && !isEvent) type = "goal";
  else if (isEvent) type = "event";

  let date: string | null = null;
  if (lower.includes("tomorrow")) date = "2026-03-19";
  else if (lower.includes("today")) date = "2026-03-18";

  let time: string | null = null;
  const timeMatch = lower.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    if (timeMatch[3]?.includes("p") && hour !== 12) hour += 12;
    if (timeMatch[3]?.includes("a") && hour === 12) hour = 0;
    time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const title = text
    .replace(/\b(remind me|create|schedule)\b/gi, "")
    .replace(/\d{1,2}:\d{2}|am|pm|today|tomorrow/gi, "")
    .trim();

  return { type, title: title || text, date, time };
}

async function sendBlooMessage(toPhone: string, message: string): Promise<boolean> {
  try {
    const BLOO_API_KEY = process.env.BLOO_API_KEY;

    if (!BLOO_API_KEY) {
      console.log("[BlooWebhook] ⚠️ Bloo API key not configured");
      return false;
    }

    const normalizedPhone = toPhone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
    console.log("[BlooWebhook] Sending Bloo message to:", normalizedPhone);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

    const response = await fetch(
      `https://backend.blooio.com/v2/api/chats/${normalizedPhone}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BLOO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: message }),
        signal: abortController.signal,
      }
    );

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      console.log("[BlooWebhook] ✅ Bloo message sent:", data);
      return true;
    } else {
      const error = await response.text();
      console.log("[BlooWebhook] ❌ Bloo API error:", error);
      return false;
    }
  } catch (error: any) {
    console.log("[BlooWebhook] ❌ Error sending message:", error.message);
    return false;
  }
}

export async function POST(req: NextRequest) {
  console.log("[BlooWebhook] Received POST request");

  try {
    const secretHeader =
      req.headers.get("x-sendblue-secret") ||
      req.headers.get("x-webhook-secret") ||
      req.headers.get("x-hook-secret") ||
      req.headers.get("x-signature");

    const expected = process.env.SENDBLUE_WEBHOOK_SECRET;

    if (expected && secretHeader && !safeEqual(secretHeader, expected)) {
      console.warn("❌ Webhook secret mismatch");
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const payload = (await req.json()) as BlooPayload;

    console.log("[BlooWebhook] ===== RAW PAYLOAD START =====");
    console.log("[BlooWebhook] Full Payload:", JSON.stringify(payload, null, 2));
    console.log("[BlooWebhook] Payload Keys:", Object.keys(payload));
    console.log("[BlooWebhook] ===== RAW PAYLOAD END =====");

    // Only process incoming messages from users
    const eventType = payload.event;
    console.log(`[BlooWebhook] Event type: ${eventType}`);

    if (eventType !== "message.received") {
      console.log(`[BlooWebhook] Ignoring event type: ${eventType} (only processing message.received)`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // Extract message text and sender
    const rawText = extractText(payload);
    const userPhone = extractSenderPhone(payload);

    console.log("[BlooWebhook] Extracted text:", rawText);
    console.log("[BlooWebhook] User phone:", userPhone);

    if (!rawText) {
      console.log("[BlooWebhook] No message text, returning 200");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    if (!userPhone) {
      console.log("[BlooWebhook] No user phone found, returning 200");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // Normalize phone and look up user
    const normalizedPhone = normalizePhone(String(userPhone));
    console.log("[BlooWebhook] Normalized phone:", normalizedPhone);

    const admin = getSupabaseAdminClient();
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .select("user_id, phone")
      .eq("phone", normalizedPhone)
      .maybeSingle();

    if (profileError || !profile?.user_id) {
      console.log("[BlooWebhook] User not found for phone:", normalizedPhone);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const userId = profile.user_id;
    console.log("[BlooWebhook] User found:", userId);

    // Analyze message intent
    console.log("[BlooWebhook] Analyzing message...");
    const analysis = await analyzeMessageWithAI(rawText);

    // Handle non-actionable messages (greetings, questions, casual chat)
    if (!analysis.type || !analysis.title) {
      console.log("[BlooWebhook] No actionable intent detected, generating conversational response...");
      
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

          const response = await model.generateContent({
            contents: [{
              parts: [{
                text: `User sent: "${rawText}"\n\nRespond naturally and briefly (1-2 sentences). Be friendly and helpful.`
              }]
            }],
            generationConfig: { maxOutputTokens: 100 }
          });

          const conversationalReply = response.response.text().trim();
          
          if (conversationalReply) {
            console.log("[BlooWebhook] Sending conversational response:", conversationalReply);
            await sendBlooMessage(normalizedPhone, conversationalReply);
            return NextResponse.json({ ok: true }, { status: 200 });
          }
        }
      } catch (error) {
        console.log("[BlooWebhook] Conversational reply error:", error);
      }
      
      // Fallback response if Gemini fails
      const fallbackReplies = [
        "Got it! 👍",
        "Thanks for letting me know! 📝",
        "I hear you! 🎯",
        "Understood! 💬",
        "Thanks for the update! ✨",
      ];
      const randomReply = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
      
      console.log("[BlooWebhook] Sending fallback response:", randomReply);
      await sendBlooMessage(normalizedPhone, randomReply);
      
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    console.log("[BlooWebhook] Processing:", analysis.type);

    // ========================================================================
    // CREATE TASK
    // ========================================================================
    if (analysis.type === "task") {
      try {
        // Get or create default list
        const { data: listData } = await admin
          .from("task_lists")
          .select("id")
          .eq("user_id", userId)
          .limit(1)
          .maybeSingle();

        let listId = listData?.id;

        if (!listId) {
          const { data: newList, error: listError } = await admin
            .from("task_lists")
            .insert({
              user_id: userId,
              name: "Personal",
              color: "#3b82f6",
              is_visible: true,
              position: 0,
            })
            .select("id")
            .single();

          if (listError || !newList?.id) {
            console.log("[BlooWebhook] Failed to create task list");
            return NextResponse.json({ ok: true }, { status: 200 });
          }
          listId = newList.id;
        }

        // Insert task
        const { error: taskError } = await admin.from("tasks").insert({
          user_id: userId,
          list_id: listId,
          title: analysis.title.slice(0, 200),
          notes: `From SMS: ${rawText.slice(0, 200)}`,
          due_date: analysis.date || null,
          due_time: analysis.time || null,
          is_completed: false,
          is_starred: false,
          position: 0,
          priority: "medium",
          progress: 0,
          metadata: {
            source: "bloo_webhook",
            originalMessage: rawText,
          },
        });

        if (taskError) {
          console.log("[BlooWebhook] Failed to create task:", taskError);
          return NextResponse.json({ ok: true }, { status: 200 });
        }

        console.log("[BlooWebhook] Task created");
        await sendBlooMessage(normalizedPhone, `✅ Task created: ${analysis.title}`);
        return NextResponse.json({ ok: true }, { status: 200 });
      } catch (error) {
        console.log("[BlooWebhook] Task creation error:", error);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
    }

    // ========================================================================
    // CREATE GOAL
    // ========================================================================
    if (analysis.type === "goal") {
      try {
        const { error: goalError } = await admin.from("goals").insert({
          user_id: userId,
          title: analysis.title.slice(0, 200),
          description: `From SMS: ${rawText.slice(0, 300)}`,
          category: "personal",
          priority: "medium",
          progress: 0,
          target_date: analysis.date || null,
        });

        if (goalError) {
          console.log("[BlooWebhook] Failed to create goal:", goalError);
          return NextResponse.json({ ok: true }, { status: 200 });
        }

        console.log("[BlooWebhook] Goal created");
        await sendBlooMessage(normalizedPhone, `🎯 Goal created: ${analysis.title}`);
        return NextResponse.json({ ok: true }, { status: 200 });
      } catch (error) {
        console.log("[BlooWebhook] Goal creation error:", error);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
    }

    // ========================================================================
    // CREATE EVENT
    // ========================================================================
    if (analysis.type === "event") {
      if (!analysis.date) {
        console.log("[BlooWebhook] Event missing date, creating task instead");
        
        const { data: listData } = await admin
          .from("task_lists")
          .select("id")
          .eq("user_id", userId)
          .limit(1)
          .maybeSingle();

        let listId = listData?.id;

        if (!listId) {
          const { data: newList } = await admin
            .from("task_lists")
            .insert({
              user_id: userId,
              name: "Personal",
              color: "#3b82f6",
              is_visible: true,
              position: 0,
            })
            .select("id")
            .single();
          listId = newList?.id;
        }

        if (listId) {
          await admin.from("tasks").insert({
            user_id: userId,
            list_id: listId,
            title: analysis.title.slice(0, 200),
            notes: `From SMS: ${rawText.slice(0, 200)}`,
            due_time: analysis.time || null,
            is_completed: false,
            is_starred: false,
            position: 0,
            priority: "medium",
            progress: 0,
          });

          await sendBlooMessage(normalizedPhone, `✅ Task created: ${analysis.title}`);
        }

        return NextResponse.json({ ok: true }, { status: 200 });
      }

      try {
        const { error: eventError } = await admin.from("calendar_events").insert({
          user_id: userId,
          title: analysis.title.slice(0, 200),
          description: `From SMS: ${rawText.slice(0, 300)}`,
          event_date: analysis.date,
          start_time: analysis.time || null,
          is_completed: false,
          category: "other",
          priority: "medium",
        });

        if (eventError) {
          console.log("[BlooWebhook] Failed to create event:", eventError);
          return NextResponse.json({ ok: true }, { status: 200 });
        }

        console.log("[BlooWebhook] Event created");
        await sendBlooMessage(normalizedPhone, `📅 Event created: ${analysis.title}`);
        return NextResponse.json({ ok: true }, { status: 200 });
      } catch (error) {
        console.log("[BlooWebhook] Event creation error:", error);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err: any) {
    console.error("[BlooWebhook] Error:", err?.message || err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
