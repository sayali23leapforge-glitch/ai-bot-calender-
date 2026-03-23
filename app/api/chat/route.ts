import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

type AllowedView =
  | "tasks"
  | "calendar"
  | "goals"
  | "priorities"
  | "focus"
  | "google"
  | "upload";

type Priority = "critical" | "high" | "medium" | "low";

type ToolCall =
  | { id?: string; name: "ui_console_log"; arguments: { message: string } }
  | { id?: string; name: "ui_alert"; arguments: { message: string } }
  | { id?: string; name: "set_active_view"; arguments: { view: AllowedView } }
  | {
      id?: string;
      name: "request_disambiguation";
      arguments: {
        prompt: string;
        kind: "task" | "event" | "goal";
        choices: Array<{ key: string; title: string; subtitle?: string }>;
        pendingTool: ToolCall;
      };
    }
  | { id?: string; name: "create_task_list"; arguments: { name: string; color?: string } }
  | {
      id?: string;
      name: "create_task";
      arguments: {
        title: string;
        notes?: string;
        dueDate?: string;
        dueTime?: string;
        priority?: Priority;
        goal?: string;
        estimatedHours?: number;
        location?: string;
        syncToCalendar?: boolean;
        listName?: string;
      };
    }
  | {
      id?: string;
      name: "create_event";
      arguments: {
        title: string;
        description?: string;
        date: string;
        time?: string;
        endTime?: string;
        location?: string;
        category?: string;
        priority?: Priority;
      };
    }
  | {
      id?: string;
      name: "create_goal";
      arguments: {
        title: string;
        description?: string;
        targetDate?: string;
        metric?: string;
      };
    }
  | {
      id?: string;
      name: "update_task_by_title";
      arguments: {
        titleQuery: string;
        title?: string;
        notes?: string;
        dueDate?: string;
        dueTime?: string;
        priority?: Priority;
        goal?: string;
        estimatedHours?: number;
        location?: string;
        progress?: number;
      };
    }
  | { id?: string; name: "complete_task_by_title"; arguments: { titleQuery: string; completed?: boolean } }
  | { id?: string; name: "star_task_by_title"; arguments: { titleQuery: string; starred?: boolean } }
  | { id?: string; name: "delete_task_by_title"; arguments: { titleQuery: string } }
  | {
      id?: string;
      name: "update_event_by_title";
      arguments: {
        titleQuery: string;
        title?: string;
        description?: string;
        date?: string;
        time?: string;
        endTime?: string;
        location?: string;
        category?: string;
        priority?: Priority;
        isCompleted?: boolean;
      };
    }
  | { id?: string; name: "delete_event_by_title"; arguments: { titleQuery: string } }
  | {
      id?: string;
      name: "update_goal_by_title";
      arguments: {
        titleQuery: string;
        title?: string;
        description?: string;
        targetDate?: string;
        progress?: number;
      };
    }
  | { id?: string; name: "delete_goal_by_title"; arguments: { titleQuery: string } }
  | {
      id?: string;
      name: "get_agenda";
      arguments: { range: "today" | "tomorrow" | "this_week" | "date"; date?: string };
    }
  | {
      id?: string;
      name: "get_agenda_v2";
      arguments: {
        range: "today" | "tomorrow" | "this_week" | "date";
        date?: string;
        includeFreeSlots?: boolean;
        durationMinutes?: number;
      };
    }
  | {
      id?: string;
      name: "detect_event_conflicts";
      arguments: {
        proposed: {
          date: string;
          startTime?: string;
          endTime?: string;
          excludeEventId?: string;
        };
      };
    };

type ChatApiResponse = {
  assistantText: string;
  toolCalls: ToolCall[];
  requestId?: string;
  silentMode?: boolean; // If true, don't show assistant message, show toast instead
  successMessage?: string; // Toast message to show (e.g., "✓ Task added")
};


type RecentEntities = {
  lastTaskTitle?: string | null;
  lastEventTitle?: string | null;
  lastGoalTitle?: string | null;
  lastTaskListName?: string | null;
  lastActiveView?: AllowedView | null;
  updatedAt?: number | null;
};

function makeRequestId() {
  const g: any = globalThis as any;
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text: string): any | null {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  const direct = safeJsonParse<any>(s);
  if (direct) return direct;
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      const candidate = s.slice(start, i + 1);
      const parsed = safeJsonParse<any>(candidate);
      if (parsed) return parsed;
      const nextStart = s.indexOf("{", i + 1);
      if (nextStart >= 0) {
        i = nextStart - 1;
        depth = 0;
        continue;
      }
      return null;
    }
  }
  return null;
}

function isConversationOnlyMessage(message: string): boolean {
  const msg = message.trim().toLowerCase();
  
  // Greetings and casual chat
  if (/^(hi|hey|hello|howdy|yo|what's up|whatsup|sup|greetings)(\s|!|\?)?$/.test(msg)) return true;
  if (/^(good morning|good afternoon|good evening|good night|good day)(\s|!)?/.test(msg)) return true;
  
  // Questions that are NOT about creation (asking for information/clarification)
  const questionPatterns = [
    /^(did you|have you|did i|can you|what did).*(\?)?$/,  // "did you create", "have you", etc.
    /^(what|when|where|why|how).*(\?)?$/,  // "what", "when", etc. - ask for info
    /^(tell me|explain|describe|clarify).*(\?)?$/,  // asking for explanation
    /^(are you|is it|is there).*(\?)?$/,  // yes/no questions
  ];
  
  if (questionPatterns.some(p => p.test(msg))) {
    // But NOT if it's clearly asking to CREATE something
    const creationKeywords = /^(create|make|add|set|schedule|plan|book|reserve|request)(\s|$)/;
    if (!creationKeywords.test(msg)) return true;
  }
  
  // Random chat or responses
  if (/^(lol|haha|hahaha|nice|cool|awesome|thanks|thank you|no|yes|ok|okay|sure)(\s|!|\?)?$/.test(msg)) return true;
  
  // Keep-alive or filler messages
  if (msg.length < 5) return true;  // Very short messages are likely not task creation
  
  return false;
}

// Helper to detect if message is requesting creation
function isCreationRequest(message: string): boolean {
  const msg = message.trim().toLowerCase();
  const creationKeywords = /\b(create|make|add|set|schedule|plan|book|reserve|request|send|remind|new|build|organize|list|prepare)\b/;
  return creationKeywords.test(msg);
}
  let s = (input || "").trim();
  if (!s) return s;
  s = s.replace(/\b(tmrw|tmrw\.|tom)\b/gi, "tomorrow");
  s = s.replace(/\btdy\b/gi, "today");
  // normalize "2pm" => "2 pm"
  s = s.replace(/\b(\d{1,2})(:\d{2})?\s*(am|pm)\b/gi, (_m, hh, mm, ap) => {
    const h = String(hh);
    const m = mm ? String(mm) : "";
    return `${h}${m} ${String(ap).toLowerCase()}`;
  });
  return s;
}

// ============
// Time helpers
// ============

/**
 * Parse common time tokens into HH:MM (24h).
 * Supports:
 *  - "2 pm", "2pm", "2:30 pm", "2:30pm"
 *  - "14:00", "9:05"
 */
function parseTimeToHHMM(input?: string): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim().toLowerCase();
  if (!s) return undefined;

  // Already HH:MM or H:MM
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{1}:\d{2}$/.test(s)) return `0${s}`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s.slice(0, 5);

  // "2 pm" or "2:30 pm" etc.
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m) {
    let hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const ap = m[3].toLowerCase();
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return undefined;
    if (hh < 1 || hh > 12 || mm < 0 || mm > 59) return undefined;
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  // "2pm" without space
  const m2 = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (m2) {
    return parseTimeToHHMM(`${m2[1]}${m2[2] ? `:${m2[2]}` : ""} ${m2[3]}`);
  }

  return undefined;
}

function normalizeHHMM(t?: string): string | undefined {
  // NOTE: now parses "2 pm" too
  return parseTimeToHHMM(t);
}

function toMinutes(hhmm?: string): number | null {
  const t = normalizeHHMM(hhmm);
  if (!t) return null;
  const [hh, mm] = t.split(":");
  const h = Number(hh);
  const m = Number(mm);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM(mins: number): string {
  const m = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function getYmdInTimeZone(timeZone: string, dateObj = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(dateObj); // YYYY-MM-DD
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isAmbiguousTitleQuery(s: string | undefined): boolean {
  const t = (s || "").trim().toLowerCase();
  if (!t) return true;
  return (
    t === "it" ||
    t === "that" ||
    t === "this" ||
    t === "that one" ||
    t === "this one" ||
    t === "the meeting" ||
    t === "the event" ||
    t === "meeting" ||
    t === "event" ||
    t === "task" ||
    t === "goal"
  );
}

function parseDurationMinutesFromText(text: string): number | null {
  const s = (text || "").toLowerCase();
  const m = s.match(/(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  if (unit.startsWith("h")) return n * 60;
  return n;
}

function looksLikeFreeTimeQuery(text: string): boolean {
  const s = (text || "").toLowerCase();
  return /\b(free|available|availability|slot|open time|open slots|when can i|when am i free)\b/.test(s);
}

function scoreMatch(title: string, q: string): number {
  const t = (title || "").toLowerCase();
  const query = (q || "").toLowerCase().trim();
  if (!query) return 0;
  if (t === query) return 100;
  if (t.startsWith(query)) return 80;
  if (t.includes(query)) return 60;
  return 0;
}

// ✅ resolve planner date tokens like "today"/"tomorrow" into YYYY-MM-DD
function resolveDateToken(dateLike: any, tz: string): string | undefined {
  const raw = String(dateLike || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const today = getYmdInTimeZone(tz);
  if (raw === "today") return today;
  if (raw === "tomorrow") return addDaysYmd(today, 1);
  return undefined;
}

// ✅ extract date from user message if planner forgot to include it
function extractDateFromUserText(text: string, tz: string): string | undefined {
  const s = String(text || "").toLowerCase();

  const m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m?.[1]) return m[1];

  const today = getYmdInTimeZone(tz);
  if (/\btomorrow\b/.test(s)) return addDaysYmd(today, 1);
  if (/\btoday\b/.test(s)) return today;

  return undefined;
}

/**
 * Pull a time (and optional endTime) from recent message history.
 * Used when user replies only with date token (e.g. "tomorrow") and planner drops the earlier time.
 */
function extractTimeFromHistory(rawMessages: any[]): { time?: string; endTime?: string } {
  const msgs = Array.isArray(rawMessages) ? rawMessages : [];
  // Look back across recent user messages for a time expression
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const txt = normalizeUserTextForLLM(String(m?.content || ""));
    // Skip pure date token replies
    if (/^(today|tomorrow|\d{4}-\d{2}-\d{2})$/i.test(txt.trim())) continue;

    // Try "from 2pm to 3pm" / "2pm-3pm" / "2 pm to 3 pm"
    const range =
      txt.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|\-|\–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i) ||
      txt.match(/(\d{1,2}:\d{2})\s*(?:to|\-|\–)\s*(\d{1,2}:\d{2})/i);

    if (range) {
      if (range.length >= 7) {
        const start = parseTimeToHHMM(`${range[1]}${range[2] ? `:${range[2]}` : ""} ${range[3]}`);
        const end = parseTimeToHHMM(`${range[4]}${range[5] ? `:${range[5]}` : ""} ${range[6]}`);
        if (start) return { time: start, endTime: end };
      }
      if (range.length === 3) {
        const start = parseTimeToHHMM(range[1]);
        const end = parseTimeToHHMM(range[2]);
        if (start) return { time: start, endTime: end };
      }
    }

    // Single time like "2pm" / "2 pm" / "14:30"
    const single =
      txt.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ||
      txt.match(/\b(\d{1,2}:\d{2})\b/);

    if (single) {
      if (single.length >= 4) {
        const start = parseTimeToHHMM(`${single[1]}${single[2] ? `:${single[2]}` : ""} ${single[3]}`);
        if (start) return { time: start };
      }
      if (single.length === 2) {
        const start = parseTimeToHHMM(single[1]);
        if (start) return { time: start };
      }
    }
  }
  return {};
}

function isDateOnlyReply(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  return t === "today" || t === "tomorrow" || /^\d{4}-\d{2}-\d{2}$/.test(t);
}

// ======================
// DB fetch via admin key
// ======================
type DbEvent = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  category: string | null;
  priority: string | null;
  is_completed: boolean | null;
};

async function fetchEventsForRangeAdmin(params: {
  userId: string;
  startDate: string;
  endDate: string;
}): Promise<DbEvent[]> {
  const { userId, startDate, endDate } = params;
  const admin = getSupabaseAdminClient();

  const { data, error } = await admin
    .from("calendar_events")
    .select("id,user_id,title,description,event_date,start_time,end_time,location,category,priority,is_completed")
    .eq("user_id", userId)
    .gte("event_date", startDate)
    .lte("event_date", endDate)
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) throw new Error(error.message);
  return (data as any[]) as DbEvent[];
}

async function fetchEventsByTitleAdmin(params: {
  userId: string;
  titleQuery: string;
  startDate: string;
  endDate: string;
  limit: number;
}): Promise<DbEvent[]> {
  const { userId, titleQuery, startDate, endDate, limit } = params;
  const admin = getSupabaseAdminClient();

  const { data, error } = await admin
    .from("calendar_events")
    .select("id,user_id,title,description,event_date,start_time,end_time,location,category,priority,is_completed")
    .eq("user_id", userId)
    .gte("event_date", startDate)
    .lte("event_date", endDate)
    .ilike("title", `%${titleQuery}%`)
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data as any[]) as DbEvent[];
}

// ===================================
// Smart slot suggestions (same day)
// ===================================
function buildBusyIntervalsForDate(events: DbEvent[], windowStart: number, windowEnd: number) {
  const hasAllDay = events.some((e) => !e.start_time || !e.end_time);
  if (hasAllDay) return [{ start: windowStart, end: windowEnd, source: "all_day" as const }];

  const intervals = events
    .map((e) => {
      const s = toMinutes(e.start_time?.slice(0, 5) || undefined);
      const en = toMinutes(e.end_time?.slice(0, 5) || undefined);
      if (s === null || en === null) return null;
      const start = Math.max(windowStart, s);
      const end = Math.min(windowEnd, en);
      if (end <= start) return null;
      return { start, end, source: e };
    })
    .filter(Boolean) as { start: number; end: number; source: DbEvent }[];

  intervals.sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number; source: DbEvent | "merged" }[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ start: iv.start, end: iv.end, source: iv.source });
      continue;
    }
    if (iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
      last.source = "merged";
    } else {
      merged.push({ start: iv.start, end: iv.end, source: iv.source });
    }
  }
  return merged;
}

function suggestSlots(params: {
  events: DbEvent[];
  preferredStartTime?: string;
  durationMinutes: number;
  windowStart: string;
  windowEnd: string;
  limit: number;
}) {
  const windowStartMin = toMinutes(params.windowStart) ?? 9 * 60;
  const windowEndMin = toMinutes(params.windowEnd) ?? 21 * 60;
  const dur = Math.max(5, Math.min(24 * 60, params.durationMinutes || 30));
  const prefMin = toMinutes(params.preferredStartTime);

  const busy = buildBusyIntervalsForDate(params.events, windowStartMin, windowEndMin);

  const free: { start: number; end: number }[] = [];
  let cursor = windowStartMin;
  for (const b of busy) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < windowEndMin) free.push({ start: cursor, end: windowEndMin });

  const candidates: { start: number; end: number }[] = [];
  for (const f of free) {
    let s = f.start;
    while (s + dur <= f.end) {
      candidates.push({ start: s, end: s + dur });
      s += 15;
      if (candidates.length > 300) break;
    }
  }

  const scored = candidates
    .map((c) => {
      const distance = prefMin === null ? 0 : Math.abs(c.start - prefMin);
      const score = 100000 - distance;
      const reason =
        prefMin === null
          ? "Available"
          : distance === 0
          ? "Exact match"
          : `Closest available (${Math.round(distance)} min away)`;
      return { ...c, score, reason };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit);

  return scored.map((s) => ({
    start_time: minutesToHHMM(s.start),
    end_time: minutesToHHMM(s.end),
    score: s.score,
    reason: s.reason,
  }));
}

// ===============================
// Deterministic task list fallback
// ===============================
function inferListNameHeuristic(title: string, notes?: string): string {
  const t = `${title || ""} ${notes || ""}`.toLowerCase();

  if (/\b(invoice|gst|payment|pay|rent|salary|tax|bank|emi|bill|cash|upi|electricity)\b/.test(t)) return "Finance";
  if (/\b(buy|order|purchase|grocery|groceries|milk|vegetable|amazon|flipkart|shopping)\b/.test(t)) return "Shopping";
  if (/\b(gym|workout|doctor|dentist|medicine|health|walk|run|yoga)\b/.test(t)) return "Health";
  if (/\b(study|homework|assignment|exam|revision|lecture|class|project)\b/.test(t)) return "Study";
  if (/\b(call|email|follow up|client|supplier|meeting|proposal|deliver|deploy|bug|fix)\b/.test(t)) return "Work";

  return "Quick Tasks";
}

// ===================================
// Planner JSON schema (multi-intent)
// ===================================
type PlannerItem =
  | {
      kind: "task";
      title: string;
      notes?: string;
      dueDate?: string;
      dueTime?: string;
      priority?: Priority;
      estimatedHours?: number;
      location?: string;
      syncToCalendar?: boolean;
      listName?: string;
    }
  | {
      kind: "event";
      title: string;
      description?: string;
      date: string;
      time?: string;
      endTime?: string;
      location?: string;
      category?: string;
      priority?: Priority;
    }
  | {
      kind: "goal";
      title: string;
      description?: string;
      targetDate?: string;
      metric?: string;
    }
  | {
      kind: "query_agenda";
      range: "today" | "tomorrow" | "this_week" | "date";
      date?: string;
    }
  | {
      kind: "query_agenda_v2";
      range: "today" | "tomorrow" | "this_week" | "date";
      date?: string;
      includeFreeSlots?: boolean;
      durationMinutes?: number;
    }
  | {
      kind: "update_event";
      titleQuery: string;
      date?: string;
      time?: string;
      endTime?: string;
      title?: string;
      description?: string;
      location?: string;
      category?: string;
      priority?: Priority;
      isCompleted?: boolean;
    }
  | {
      kind: "update_task";
      titleQuery: string;
      title?: string;
      notes?: string;
      dueDate?: string;
      dueTime?: string;
      priority?: Priority;
      estimatedHours?: number;
      location?: string;
      progress?: number;
    }
  | { kind: "complete_task"; titleQuery: string; completed?: boolean }
  | { kind: "delete_task"; titleQuery: string }
  | { kind: "delete_event"; titleQuery: string }
  | { kind: "create_task_list"; name: string; color?: string };

type PlannerOutput = {
  assistantText?: string;
  isConversationOnly?: boolean;
  items: PlannerItem[];
};

// ===========================
// OpenAI call helper
// ===========================
async function callGemini(geminiApiKey: string, messages: any[]) {
  // Use gemini-2.5-flash model with new API format
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const userMsg = messages.find(m => m.role === 'user')?.content || '';
  
  const fullPrompt = systemMsg ? `${systemMsg}\n\n${userMsg}` : userMsg;

  const geminiResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: fullPrompt,
            },
          ],
        },
      ],
    }),
  });

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    console.error("Gemini error:", errText);
    return { ok: false, status: geminiResp.status, data: null as any, errText };
  }

  const data = await geminiResp.json();
  // Transform Gemini response to OpenAI-like format
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return { 
    ok: true, 
    status: 200, 
    data: { 
      choices: [{ 
        message: { content } 
      }] 
    }, 
    errText: "" 
  };
}

function formatEventLine(e: DbEvent) {
  const st = e.start_time ? e.start_time.slice(0, 5) : "All day";
  const en = e.end_time ? e.end_time.slice(0, 5) : "";
  const time = e.start_time ? `${st}–${en}` : st;
  return `• ${time} — ${e.title}${e.location ? ` (${e.location})` : ""}`;
}

function groupEventsByDate(events: DbEvent[]) {
  const map = new Map<string, DbEvent[]>();
  for (const e of events) {
    const key = e.event_date || "unknown";
    const arr = map.get(key) || [];
    arr.push(e);
    map.set(key, arr);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const requestId = makeRequestId();

  try {
    const body = await req.json();

    const clientRequestId: string = (body?.requestId || "").trim();
    const rid = clientRequestId || requestId;

    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const context = body?.context ?? {};
    const tz: string = context?.timezone || "Asia/Kolkata";

    const recentEntities: RecentEntities =
      context?.recentEntities && typeof context.recentEntities === "object" ? context.recentEntities : {};

    const userIdFromBody: string = (body?.userId || body?.user_id || body?.uid || "").trim();

    console.log("[/api/chat] Received userId:", { 
      fromBody: userIdFromBody, 
      bodyKeys: Object.keys(body || {}),
      bodyUserId: body?.userId 
    });

    if (!rawMessages.length) {
      return NextResponse.json(
        { assistantText: "Send a message to start.", toolCalls: [], requestId: rid } satisfies ChatApiResponse,
        { status: 400 }
      );
    }

    const lastUserMsg = [...rawMessages]
      .reverse()
      .find((m: any) => m?.role === "user" && typeof m?.content === "string");

    const lastUserTextRaw = (lastUserMsg?.content || "").toString();
    const lastUserText = normalizeUserTextForLLM(lastUserTextRaw);

    if (!lastUserText.trim()) {
      return NextResponse.json(
        { assistantText: "Send a message to start.", toolCalls: [], requestId: rid } satisfies ChatApiResponse,
        { status: 400 }
      );
    }

    // Get Gemini API key from environment (Supabase table may not exist yet)
    let geminiApiKey = process.env.GEMINI_API_KEY;
    
    // Try to get from api_keys table if available
    if (!geminiApiKey) {
      try {
        const { data: apiKeyData } = await supabase
          .from("api_keys")
          .select("api_key")
          .eq("service_name", "gemini")
          .maybeSingle();
        
        if (apiKeyData?.api_key) {
          geminiApiKey = apiKeyData.api_key;
        }
      } catch (e) {
        // api_keys table may not exist yet, continue with env var
        console.debug('api_keys table not yet available:', e instanceof Error ? e.message : 'unknown error');
      }
    }
    
    if (!geminiApiKey) {
      return NextResponse.json(
        {
          assistantText: "Gemini API key is not configured. Add it to env or api_keys table.",
          toolCalls: [],
          requestId: rid,
        } satisfies ChatApiResponse,
        { status: 500 }
      );
    }

    const contextMessages = rawMessages.slice(-10).map((m: any) => {
      if (m?.role === "user" && typeof m?.content === "string") {
        return { role: "user", content: normalizeUserTextForLLM(m.content) };
      }
      return { role: m?.role, content: m?.content };
    });

    const durationFromText = parseDurationMinutesFromText(lastUserText);
    const durationHint = (() => {
      const dur = durationFromText;
      const looksLikeFollowup =
        /\b(make it|change it|set it|move it|reschedule it|extend it|shorten it)\b/i.test(lastUserText) ||
        /\b(\bit\b|\bthat\b|\bthis\b)\b/i.test(lastUserText);

      if (!dur || !looksLikeFollowup) return "";
      return `\nFOLLOWUP DURATION HINT: The user likely wants the LAST EVENT duration to be ${dur} minutes.\nIf updating an event time range, set endTime = startTime + ${dur} minutes (same date unless user specifies otherwise).`;
    })();

    const recentEntitiesBlock = `
RecentEntities (from client, most recent user targets):
- lastEventTitle: ${recentEntities?.lastEventTitle ? JSON.stringify(recentEntities.lastEventTitle) : "null"}
- lastTaskTitle: ${recentEntities?.lastTaskTitle ? JSON.stringify(recentEntities.lastTaskTitle) : "null"}
- lastGoalTitle: ${recentEntities?.lastGoalTitle ? JSON.stringify(recentEntities.lastGoalTitle) : "null"}
- lastTaskListName: ${recentEntities?.lastTaskListName ? JSON.stringify(recentEntities.lastTaskListName) : "null"}
- lastActiveView: ${recentEntities?.lastActiveView ? JSON.stringify(recentEntities.lastActiveView) : "null"}

If the user says "it/that/this" and does NOT provide a clear title:
- For event updates/deletes: use lastEventTitle as titleQuery.
- For task updates/completes/deletes: use lastTaskTitle as titleQuery.
- For goal updates/deletes: use lastGoalTitle as titleQuery.
`.trim();

    const plannerSystem = `
You are the "Planner" for a personal assistant.

CRITICAL: Return ONLY a valid JSON object:
{
  "assistantText": string (optional, for clarifications/questions),
  "isConversationOnly": boolean (if true: user is chatting/asking, NOT requesting creation),
  "items": [ ...PlannerItem ]
}

=== RULES FOR isConversationOnly ===
Set isConversationOnly=true ONLY if the message is:
- A greeting ("Hi", "Hello", "Hey")
- A casual response ("Thanks", "Cool", "Ok", "Sure")
- A question seeking information (NOT creation): "Did you create...", "What is...", "When is..."
- Random chatter or filler messages
- Asking clarifying questions about existing items

Set isConversationOnly=false if the message clearly requests creation/action:
- "Create a task called X"
- "Schedule a meeting"
- "Add X to my list"
- "Make a note about X"

=== CRITICAL RULES FOR ITEMS ===
- ONLY emit items if isConversationOnly=false
- If isConversationOnly=true, ALWAYS set items: [] (empty array)
- Create actions ONLY for the LATEST user message
- NEVER re-emit past tasks/events again
- Filter out creation attempts when user is just chatting

=== MESSAGE ANALYSIS ===
LATEST USER MESSAGE:
"""${lastUserText}"""

Before planning, ask yourself:
1. Is this a greeting or casual message? → isConversationOnly=true
2. Is this seeking information (not creating)? → isConversationOnly=true
3. Does this request creation/action? → isConversationOnly=false
4. Is this a follow-up to a past topic? → Check context, may be conversation-only

ABSOLUTE DATE RULE:
- For ANY event/task due date, output a real date string in YYYY-MM-DD
- Convert words like "today" and "tomorrow" into YYYY-MM-DD
- If user gives weekday without a clear date, ask a follow-up question instead of guessing

TIME EXTRACTION FOR EVENTS:
- ALWAYS look for time mentions in user message (e.g., "2pm", "14:00", "2:30 pm", "at 3")
- Convert times to HH:MM format (24-hour): "2pm" → "14:00", "2:30am" → "02:30"
- If time is mentioned, ALWAYS include "time" field in event (never omit)
- If NO time mentioned, OMIT the "time" field (creates all-day event)

PRIORITY EXTRACTION:
- Look for urgency/priority words in user message
- "critical", "urgent", "asap" => priority: "critical"
- "high priority", "important" => priority: "high"
- "medium", "normal" => priority: "medium"
- "low", "whenever" => priority: "low"
- If no priority word mentioned, default to "medium"

Rules for items:
- If user asks "agenda/calendar today/tomorrow/this week" => kind="query_agenda_v2"
- If user asks "when am I free / available / free slots" => query_agenda_v2 with includeFreeSlots=true
- If message contains multiple intents, emit multiple items
- Goal/objective/target => kind="goal"
- Meeting/appointment/event with date/time => kind="event" or update_event
- Task/to-do/action items => kind="task"
- Create task list => kind="create_task_list"
- For tasks: infer listName from context (Work/Study/Health/Shopping/Personal)
- Keep titles short; put details in notes/description
- Output must be strict JSON (no code fences, no trailing commas)

Timezone: ${tz}
Now ISO: ${new Date().toISOString()}

${recentEntitiesBlock}
${durationHint}
`.trim();

    const planner = await callGemini(geminiApiKey, [
      { role: "system", content: plannerSystem }, 
      ...contextMessages
    ]);

    if (!planner.ok) {
      return NextResponse.json(
        { assistantText: `Gemini API error: ${planner.status}`, toolCalls: [], requestId: rid } satisfies ChatApiResponse,
        { status: planner.status }
      );
    }

    const plannerMsg = planner.data?.choices?.[0]?.message?.content || "";
    const extracted = extractFirstJsonObject(plannerMsg);
    const plan = extracted as PlannerOutput | null;

    console.log("[/api/chat] Planner response:", { 
      rid, 
      plannerMsgLength: plannerMsg?.length,
      plannerMsgPreview: plannerMsg?.substring(0, 200),
      extracted: extracted ? JSON.stringify(extracted).substring(0, 300) : null,
      planItems: plan?.items?.length,
      planItemsPreview: plan?.items?.slice(0, 2)
    });

    if (!plan || !Array.isArray((plan as any).items)) {
      console.error("[/api/chat] planner parse failed", { rid, plannerMsg });
      return NextResponse.json({
        assistantText: "I couldn’t parse that cleanly. Try: 'meet tomorrow 2pm with Rahul' or 'agenda tomorrow'.",
        toolCalls: [],
        requestId: rid,
      } satisfies ChatApiResponse);
    }

    // --- CONVERSATION-ONLY MESSAGE HANDLING ---
    if ((plan as any).isConversationOnly === true) {
      console.log("[/api/chat] Detected conversation-only message, generating natural response");
      
      // Call Gemini to generate a conversational response (no creation actions)
      const conversationSystem = `You are a friendly, helpful AI assistant. The user is chatting with you for conversation, information, or clarification.

Respond naturally and conversationally. Be brief, friendly, and helpful.
- For greetings: return a warm greeting back
- For questions: answer helpfully if you can
- For casual chatter: engage naturally
- For clarifications: provide clear explanations

Keep responses concise (1-2 sentences usually).`;

      const conversationResp = await callGemini(geminiApiKey, [
        { role: "system", content: conversationSystem },
        ...contextMessages
      ]);

      if (!conversationResp.ok) {
        return NextResponse.json({
          assistantText: "I'm having trouble responding right now. Please try again.",
          toolCalls: [],
          requestId: rid,
        } satisfies ChatApiResponse);
      }

      const conversationalText = conversationResp.data?.choices?.[0]?.message?.content || "Got it!";

      console.log("[/api/chat] Conversational response sent:", { rid, responseLength: conversationalText?.length });

      return NextResponse.json({
        assistantText: conversationalText,
        toolCalls: [],
        requestId: rid,
      } satisfies ChatApiResponse);
    }
    // --- END CONVERSATION-ONLY HANDLING ---

    // Fix up ambiguous titleQuery using RecentEntities
    const fixedItems: PlannerItem[] = (plan.items || []).map((it: any) => {
      if (!it || typeof it !== "object") return it;

      if (it.kind === "update_event" || it.kind === "delete_event") {
        const tq = String(it.titleQuery || "").trim();
        if (isAmbiguousTitleQuery(tq) && recentEntities?.lastEventTitle) {
          return { ...it, titleQuery: recentEntities.lastEventTitle };
        }
      }

      if (it.kind === "update_task" || it.kind === "complete_task" || it.kind === "delete_task") {
        const tq = String(it.titleQuery || "").trim();
        if (isAmbiguousTitleQuery(tq) && recentEntities?.lastTaskTitle) {
          return { ...it, titleQuery: recentEntities.lastTaskTitle };
        }
      }

      return it;
    });

    plan.items = fixedItems;

    // Normalize title for deduplication (remove punctuation, extra spaces, etc)
    const normalizeTitle = (title: string): string => {
      return title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s]/g, '') // Remove special characters
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
    };

    // Aggressive deduplication: filter by normalized title + kind + dueDate
    const seenItems = new Set<string>();
    const originalItemCount = plan.items.length;
    
    plan.items = plan.items.filter((item: any) => {
      if (!item || !item.title || !item.kind) return true; // Keep items without required fields
      
      const normalizedTitle = normalizeTitle(item.title);
      const itemKind = item.kind;
      const dueDate = item.dueDate || item.date || '';
      const itemKey = `${itemKind}:${normalizedTitle}:${dueDate}`;
      
      if (seenItems.has(itemKey)) {
        console.log("[/api/chat] FILTERED DUPLICATE:", { 
          kind: itemKind, 
          title: item.title,
          normalized: normalizedTitle,
          dueDate,
          itemKey 
        });
        return false;
      }
      seenItems.add(itemKey);
      return true;
    });

    console.log("[/api/chat] Aggressive deduplication:", { 
      originalCount: originalItemCount,
      afterDedup: plan.items.length,
      filtered: originalItemCount - plan.items.length,
      items: plan.items.map((i: any) => ({ kind: i.kind, title: i.title }))
    });

    // Extract all previously created items from database (not messages)
    const extractPreviouslyCreatedItems = async (userId: string): Promise<{ taskTitles: Set<string>; goalTitles: Set<string>; eventTitles: Set<string> }> => {
      const taskTitles = new Set<string>();
      const goalTitles = new Set<string>();
      const eventTitles = new Set<string>();

      try {
        const admin = getSupabaseAdminClient();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        // Query recently created tasks (last hour)
        const { data: tasks, error: tasksError } = await admin
          .from('tasks')
          .select('title')
          .eq('user_id', userId)
          .gt('created_at', oneHourAgo);

        if (!tasksError && tasks) {
          tasks.forEach((task: any) => {
            if (task.title) taskTitles.add(normalizeTitle(task.title));
          });
        }

        // Query recently created goals (last hour)
        const { data: goals, error: goalsError } = await admin
          .from('goals')
          .select('title')
          .eq('user_id', userId)
          .gt('created_at', oneHourAgo);

        if (!goalsError && goals) {
          goals.forEach((goal: any) => {
            if (goal.title) goalTitles.add(normalizeTitle(goal.title));
          });
        }

        // Query recently created events (last hour)
        const { data: events, error: eventsError } = await admin
          .from('calendar_events')
          .select('title')
          .eq('user_id', userId)
          .gt('created_at', oneHourAgo);

        if (!eventsError && events) {
          events.forEach((event: any) => {
            if (event.title) eventTitles.add(normalizeTitle(event.title));
          });
        }

        console.log("[/api/chat] Previously created items from database:", {
          taskCount: taskTitles.size,
          goalCount: goalTitles.size,
          eventCount: eventTitles.size,
          tasks: Array.from(taskTitles),
          goals: Array.from(goalTitles),
          events: Array.from(eventTitles)
        });
      } catch (err) {
        console.error("[/api/chat] Error extracting previously created items:", err);
      }

      return { taskTitles, goalTitles, eventTitles };
    };

    const { taskTitles: prevTaskTitles, goalTitles: prevGoalTitles, eventTitles: prevEventTitles } = await extractPreviouslyCreatedItems(userIdFromBody);

    const clientToolCalls: ToolCall[] = [];
    const serverToolCalls: Array<{ name: ToolCall["name"]; arguments: any }> = [];
    const processedTaskTitles = new Set<string>([...prevTaskTitles]); // Track created tasks + previously created
    const processedGoalTitles = new Set<string>([...prevGoalTitles]); // Track created goals + previously created
    const processedEventTitles = new Set<string>([...prevEventTitles]); // Track created events + previously created

    function pushClient(tc: ToolCall) {
      clientToolCalls.push(tc);
    }
    function pushServer(name: ToolCall["name"], args: any) {
      serverToolCalls.push({ name, arguments: args });
    }

    const pendingFollowups: string[] = [];

    // Precompute carry-forward time for date-only followups
    const carry = isDateOnlyReply(lastUserText) ? extractTimeFromHistory(rawMessages) : {};

    for (const item of plan.items) {
      if (!item || typeof item !== "object") continue;

      if (item.kind === "query_agenda") {
        pushServer("get_agenda", { range: item.range, date: item.date });
        continue;
      }

      if (item.kind === "query_agenda_v2") {
        pushServer("get_agenda_v2", {
          range: item.range,
          date: item.date,
          includeFreeSlots: item.includeFreeSlots ?? looksLikeFreeTimeQuery(lastUserText),
          durationMinutes: item.durationMinutes ?? durationFromText ?? 60,
        });
        continue;
      }

      if (item.kind === "create_task_list") {
        const listName = (item as any).name || (item as any).listName || "New List";
        pushClient({ name: "create_task_list", arguments: { name: listName, color: (item as any).color } });
        continue;
      }

      if (item.kind === "task") {
        // Deduplicate: use normalized title for comparison
        const normalizedTitle = normalizeTitle(item.title || "");
        if (processedTaskTitles.has(normalizedTitle)) {
          console.log("[/api/chat] SKIPPING PROCESSED TASK:", { 
            title: item.title, 
            normalized: normalizedTitle 
          });
          continue;
        }
        processedTaskTitles.add(normalizedTitle);

        const listName = (item.listName && item.listName.trim()) || inferListNameHeuristic(item.title, item.notes);

        console.log("[/api/chat] Creating task:", { title: item.title, normalized: normalizedTitle });
        pushClient({
          name: "create_task",
          arguments: {
            title: item.title,
            notes: item.notes,
            dueDate: item.dueDate,
            dueTime: item.dueTime,
            priority: item.priority,
            estimatedHours: item.estimatedHours,
            location: item.location,
            syncToCalendar: false, // Let task creation API handle calendar sync
            listName,
          },
        });
        continue;
      }

      if (item.kind === "event") {
        // --- Date resolution ---
        const resolvedDate =
          resolveDateToken((item as any).date, tz) ||
          extractDateFromUserText(lastUserText, tz) ||
          (/^\d{4}-\d{2}-\d{2}$/.test(String((item as any).date || "")) ? String((item as any).date) : undefined);

        if (!resolvedDate) {
          pendingFollowups.push("What date is the meeting on? (Example: 2026-01-10)");
          continue;
        }

        // --- Time resolution ---
        // Prefer planner time; if missing AND this is a date-only follow-up, carry forward from history
        const rawStart = (item as any).time || (isDateOnlyReply(lastUserText) ? carry.time : undefined);
        const rawEnd = (item as any).endTime || (isDateOnlyReply(lastUserText) ? carry.endTime : undefined);

        const start = normalizeHHMM(rawStart);
        const end = normalizeHHMM(rawEnd);

        (item as any).date = resolvedDate;
        (item as any).time = start;
        (item as any).endTime = end;

        // Deduplicate: use normalized title + date + time for comparison
        const normalizedTitle = normalizeTitle(item.title || "");
        const eventKey = `${normalizedTitle}:${resolvedDate}:${start}`;
        if (processedEventTitles.has(eventKey)) {
          console.log("[/api/chat] SKIPPING PROCESSED EVENT:", { 
            title: item.title, 
            normalized: normalizedTitle,
            date: resolvedDate,
            time: start
          });
          continue;
        }
        processedEventTitles.add(eventKey);

        if (resolvedDate && start) {
          pushServer("detect_event_conflicts", {
            proposed: { date: resolvedDate, startTime: start, endTime: end || undefined },
          });
        }

        console.log("[/api/chat] Creating event:", { title: item.title, normalized: normalizedTitle, date: resolvedDate, time: start });
        pushClient({
          name: "create_event",
          arguments: {
            title: item.title,
            description: item.description,
            date: resolvedDate as any,
            time: start,
            endTime: end,
            location: item.location,
            category: item.category,
            priority: item.priority,
          },
        });
        continue;
      }

      if (item.kind === "goal") {
        // Deduplicate: use normalized title for comparison
        const normalizedTitle = normalizeTitle(item.title || "");
        if (processedGoalTitles.has(normalizedTitle)) {
          console.log("[/api/chat] SKIPPING PROCESSED GOAL:", { 
            title: item.title, 
            normalized: normalizedTitle 
          });
          continue;
        }
        processedGoalTitles.add(normalizedTitle);

        console.log("[/api/chat] Creating goal:", { title: item.title, normalized: normalizedTitle });
        pushClient({
          name: "create_goal",
          arguments: {
            title: item.title,
            description: item.description,
            targetDate: item.targetDate,
            metric: item.metric,
          },
        });
        continue;
      }

      if (item.kind === "update_event") {
        const resolvedDate =
          resolveDateToken((item as any).date, tz) ||
          (/^\d{4}-\d{2}-\d{2}$/.test(String((item as any).date || "")) ? String((item as any).date) : undefined);

        const start = normalizeHHMM(item.time);
        const end = normalizeHHMM(item.endTime);

        (item as any).date = resolvedDate;

        if ((resolvedDate || undefined) && (start || end)) {
          pushServer("detect_event_conflicts", {
            proposed: {
              date: resolvedDate || getYmdInTimeZone(tz),
              startTime: start,
              endTime: end,
            },
          });
        }

        pushClient({
          name: "update_event_by_title",
          arguments: {
            titleQuery: item.titleQuery,
            title: item.title,
            description: item.description,
            date: resolvedDate,
            time: start,
            endTime: end,
            location: item.location,
            category: item.category,
            priority: item.priority,
            isCompleted: item.isCompleted,
          },
        });
        continue;
      }

      if (item.kind === "update_task") {
        pushClient({
          name: "update_task_by_title",
          arguments: {
            titleQuery: item.titleQuery,
            title: item.title,
            notes: item.notes,
            dueDate: item.dueDate,
            dueTime: item.dueTime,
            priority: item.priority,
            estimatedHours: item.estimatedHours,
            location: item.location,
            progress: item.progress,
          },
        });
        continue;
      }

      if (item.kind === "complete_task") {
        pushClient({ name: "complete_task_by_title", arguments: { titleQuery: item.titleQuery, completed: item.completed } });
        continue;
      }

      if (item.kind === "delete_task") {
        pushClient({ name: "delete_task_by_title", arguments: { titleQuery: item.titleQuery } });
        continue;
      }

      if (item.kind === "delete_event") {
        pushClient({ name: "delete_event_by_title", arguments: { titleQuery: item.titleQuery } });
        continue;
      }
    }

    if (pendingFollowups.length > 0 && clientToolCalls.length === 0 && serverToolCalls.length === 0) {
      return NextResponse.json({
        assistantText: pendingFollowups[0],
        toolCalls: [{ id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } }],
        requestId: rid,
      } satisfies ChatApiResponse);
    }

    const uid = userIdFromBody;
    const serverResults: Record<string, any> = {};

    if (!uid && serverToolCalls.length > 0) {
      return NextResponse.json(
        {
          assistantText: "Please sign in again — I need your session to read your calendar for agenda/conflicts.",
          toolCalls: [],
          requestId: rid,
        } satisfies ChatApiResponse
      );
    }

    // server-side disambiguation for event update/delete
    {
      const firstEventAction = clientToolCalls.find(
        (tc) => tc.name === "update_event_by_title" || tc.name === "delete_event_by_title"
      ) as ToolCall | undefined;

      if (uid && firstEventAction) {
        const titleQuery = String((firstEventAction as any).arguments?.titleQuery || "").trim();
        if (titleQuery && !isAmbiguousTitleQuery(titleQuery)) {
          const today = getYmdInTimeZone(tz);
          const start = addDaysYmd(today, -30);
          const end = addDaysYmd(today, 90);

          const rawMatches = await fetchEventsByTitleAdmin({
            userId: uid,
            titleQuery,
            startDate: start,
            endDate: end,
            limit: 25,
          });

          const scored = rawMatches
            .map((e) => ({ e, s: scoreMatch(e.title, titleQuery) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s);

          const bestScore = scored[0]?.s ?? 0;
          const best = scored.filter((x) => x.s === bestScore).map((x) => x.e);

          if (best.length > 1) {
            const choices = best.slice(0, 8).map((ev) => {
              const st = ev.start_time ? ev.start_time.slice(0, 5) : "All day";
              const en = ev.end_time ? ev.end_time.slice(0, 5) : "";
              const time = ev.start_time ? `${st}–${en}` : st;
              return {
                key: ev.id,
                title: ev.title,
                subtitle: `${ev.event_date} • ${time}`,
              };
            });

            const filteredClient = clientToolCalls.filter((x) => x !== firstEventAction);

            return NextResponse.json({
              assistantText: "",
              toolCalls: [
                { id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } },
                ...filteredClient.map((tc, idx) => ({ ...tc, id: tc.id || `${rid}:c_${idx}` })),
                {
                  id: `${rid}:disambig_evt`,
                  name: "request_disambiguation",
                  arguments: {
                    prompt: `I found multiple events matching “${titleQuery}”. Which one do you mean?`,
                    kind: "event",
                    choices,
                    pendingTool: firstEventAction,
                  },
                },
              ],
              requestId: rid,
            } satisfies ChatApiResponse);
          }
        }
      }
    }

    for (const st of serverToolCalls) {
      if (st.name === "get_agenda") {
        const range = st.arguments?.range as "today" | "tomorrow" | "this_week" | "date";
        const today = getYmdInTimeZone(tz);
        let start = today;
        let end = today;

        if (range === "tomorrow") {
          start = addDaysYmd(today, 1);
          end = start;
        } else if (range === "this_week") {
          start = today;
          end = addDaysYmd(today, 7);
        } else if (range === "date") {
          const d = (st.arguments?.date || "").trim();
          if (d) {
            start = d;
            end = d;
          }
        }

        const events = await fetchEventsForRangeAdmin({ userId: uid, startDate: start, endDate: end });
        serverResults["agenda"] = { range, startDate: start, endDate: end, events };
        continue;
      }

      if (st.name === "get_agenda_v2") {
        const range = st.arguments?.range as "today" | "tomorrow" | "this_week" | "date";
        const includeFreeSlots = Boolean(st.arguments?.includeFreeSlots);
        const durationMinutes = Number(st.arguments?.durationMinutes || 60);

        const today = getYmdInTimeZone(tz);
        let start = today;
        let end = today;

        if (range === "tomorrow") {
          start = addDaysYmd(today, 1);
          end = start;
        } else if (range === "this_week") {
          start = today;
          end = addDaysYmd(today, 7);
        } else if (range === "date") {
          const d = (st.arguments?.date || "").trim();
          if (d) {
            start = d;
            end = d;
          }
        }

        const events = await fetchEventsForRangeAdmin({ userId: uid, startDate: start, endDate: end });

        let slots: Array<{ start_time: string; end_time: string; reason: string }> = [];
        if (includeFreeSlots) {
          const day = start;
          const dayEvents = events.filter((e) => e.event_date === day);
          slots = suggestSlots({
            events: dayEvents,
            preferredStartTime: undefined,
            durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 60,
            windowStart: "09:00",
            windowEnd: "21:00",
            limit: 6,
          }).map((s) => ({ start_time: s.start_time, end_time: s.end_time, reason: s.reason }));
        }

        serverResults["agenda_v2"] = {
          range,
          startDate: start,
          endDate: end,
          events,
          includeFreeSlots,
          durationMinutes,
          slots,
        };
        continue;
      }

      if (st.name === "detect_event_conflicts") {
        const proposed = st.arguments?.proposed || {};
        const date = resolveDateToken(proposed?.date, tz) || String(proposed?.date || "").trim();
        const startTime = normalizeHHMM(proposed?.startTime);
        const endTime = normalizeHHMM(proposed?.endTime);

        const events = await fetchEventsForRangeAdmin({ userId: uid, startDate: date, endDate: date });

        if (!startTime) {
          serverResults["conflicts"] = { ok: true, hasTime: false, conflicts: [], note: "No start time." };
          continue;
        }

        const dur = durationFromText ?? 60;
        const pStart = toMinutes(startTime);
        const pEnd = toMinutes(endTime || minutesToHHMM((pStart ?? 0) + dur));
        const conflicts: any[] = [];

        if (pStart !== null && pEnd !== null) {
          for (const e of events) {
            if (!e.start_time || !e.end_time) {
              conflicts.push({
                id: e.id,
                title: e.title,
                start_time: e.start_time,
                end_time: e.end_time,
                reason: "All-day/untimed event",
              });
              continue;
            }
            const es = toMinutes(e.start_time.slice(0, 5));
            const ee = toMinutes(e.end_time.slice(0, 5));
            if (es === null || ee === null) continue;
            if (overlap(pStart, pEnd, es, ee)) {
              conflicts.push({
                id: e.id,
                title: e.title,
                start_time: e.start_time,
                end_time: e.end_time,
                location: e.location,
              });
            }
          }
        }

        serverResults["conflicts"] = {
          ok: true,
          date,
          startTime,
          endTime: endTime || minutesToHHMM((pStart ?? 0) + dur),
          conflicts,
          durationMinutes: dur,
        };
        continue;
      }
    }

    const conflicts = serverResults?.conflicts?.conflicts || [];
    const hasConflict = Array.isArray(conflicts) && conflicts.length > 0;

    if (hasConflict) {
      const date = serverResults?.conflicts?.date as string;
      const startTime = serverResults?.conflicts?.startTime as string;
      const endTime = (serverResults?.conflicts?.endTime as string) || undefined;
      const dur = Number(serverResults?.conflicts?.durationMinutes || 60);

      const events = await fetchEventsForRangeAdmin({ userId: uid, startDate: date, endDate: date });
      const slots = suggestSlots({
        events,
        preferredStartTime: startTime,
        durationMinutes: dur,
        windowStart: "09:00",
        windowEnd: "21:00",
        limit: 5,
      });

      const filteredClient = clientToolCalls.filter(
        (tc) => tc.name !== "create_event" && tc.name !== "update_event_by_title"
      );

      const conflictLines = conflicts
        .slice(0, 5)
        .map((c: any) => `• ${c.title} (${(c.start_time || "").slice(0, 5)}–${(c.end_time || "").slice(0, 5)})`)
        .join("\n");

      const slotLines = slots.map((s) => `• ${s.start_time}–${s.end_time} (${s.reason})`).join("\n");

      const toolCallsWithIds: ToolCall[] = [
        { id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } },
        ...filteredClient.map((tc, idx) => ({ ...tc, id: tc.id || `${rid}:c_${idx}` })),
      ];

      return NextResponse.json({
        assistantText:
          `That time conflicts with your calendar on ${date} (${startTime}${endTime ? `–${endTime}` : ""}).\n\nConflicts:\n${conflictLines}\n\nSuggested open slots (${dur} min):\n${slotLines}\n\nReply with one of the suggested times (e.g., “move it to ${slots[0]?.start_time}”).`,
        toolCalls: toolCallsWithIds,
        requestId: rid,
      } satisfies ChatApiResponse);
    }

    if (serverResults?.agenda?.events) {
      const range = serverResults.agenda.range;
      const events: DbEvent[] = serverResults.agenda.events || [];
      if (!events.length) {
        return NextResponse.json({
          assistantText: range === "today" ? "You have nothing scheduled today." : "Nothing scheduled in that range.",
          toolCalls: [{ id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } }],
          requestId: rid,
        } satisfies ChatApiResponse);
      }

      const lines = events.slice(0, 25).map((e) => formatEventLine(e));

      return NextResponse.json({
        assistantText: `Here’s your agenda (${range}):\n\n${lines.join("\n")}`,
        toolCalls: [{ id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } }],
        requestId: rid,
      } satisfies ChatApiResponse);
    }

    if (serverResults?.agenda_v2) {
      const { range, events, includeFreeSlots, durationMinutes, slots, startDate } = serverResults.agenda_v2 as any;

      if (!events?.length) {
        const msg =
          range === "today" ? "You have nothing scheduled today." : "Nothing scheduled in that range.";
        const extra =
          includeFreeSlots && slots?.length
            ? `\n\nFree slots (${durationMinutes} min):\n${slots
                .map((s: any) => `• ${s.start_time}–${s.end_time} (${s.reason})`)
                .join("\n")}`
            : "";
        return NextResponse.json({
          assistantText: msg + extra,
          toolCalls: [{ id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } }],
          requestId: rid,
        } satisfies ChatApiResponse);
      }

      const groups = groupEventsByDate(events as DbEvent[]);
      const chunks: string[] = [];
      for (const [date, list] of groups) {
        chunks.push(`${date}`);
        chunks.push(...list.map((e) => "  " + formatEventLine(e)));
        chunks.push("");
      }

      let slotBlock = "";
      if (includeFreeSlots) {
        const slotLines =
          slots?.length
            ? slots.map((s: any) => `• ${s.start_time}–${s.end_time} (${s.reason})`).join("\n")
            : "• No open slots found in 09:00–21:00.";
        slotBlock = `\nFree slots (${durationMinutes} min) for ${startDate}:\n${slotLines}\n`;
      }

      return NextResponse.json({
        assistantText: `Agenda (${range}):\n\n${chunks.join("\n")}${slotBlock}`.trim(),
        toolCalls: [{ id: `${rid}:view`, name: "set_active_view", arguments: { view: "calendar" } }],
        requestId: rid,
      } satisfies ChatApiResponse);
    }

    const assistantText = (plan.assistantText && String(plan.assistantText).trim()) || "Done — I’ve handled that.";

    const toolCallsWithIds = clientToolCalls.map((tc, idx) => ({
      ...tc,
      id: tc.id || `${rid}:t_${idx}`,
    }));

    console.log("[/api/chat] Sending response:", { 
      rid, 
      assistantText, 
      toolCallsCount: toolCallsWithIds.length,
      toolCallsPreview: toolCallsWithIds.slice(0, 3).map(tc => ({ name: tc.name, args: JSON.stringify(tc.arguments).substring(0, 100) }))
    });

    console.log("[/api/chat] ok", { rid, userId: uid ? "yes" : "no", ms: Date.now() - startedAt });

    // Detect if this is a silent operation (routine task/event/goal creation)
    const isSilentOperation = toolCallsWithIds.length > 0 && 
      toolCallsWithIds.every(tc => ['create_task', 'create_event', 'create_goal', 'create_task_list'].includes(tc.name));
    
    let successMessage = '';
    if (isSilentOperation) {
      const taskCount = toolCallsWithIds.filter(tc => tc.name === 'create_task').length;
      const eventCount = toolCallsWithIds.filter(tc => tc.name === 'create_event').length;
      const goalCount = toolCallsWithIds.filter(tc => tc.name === 'create_goal').length;
      
      if (taskCount > 0) successMessage = `✓ ${taskCount === 1 ? 'Task' : taskCount + ' tasks'} added`;
      else if (eventCount > 0) successMessage = `✓ ${eventCount === 1 ? 'Event' : eventCount + ' events'} added`;
      else if (goalCount > 0) successMessage = `✓ ${goalCount === 1 ? 'Goal' : goalCount + ' goals'} added`;
    }

    return NextResponse.json({
      assistantText: isSilentOperation ? '' : assistantText,
      toolCalls: toolCallsWithIds,
      requestId: rid,
      silentMode: isSilentOperation,
      successMessage: isSilentOperation ? successMessage : undefined,
    } satisfies ChatApiResponse);
  } catch (e: any) {
    console.error("api/chat error:", e);
    return NextResponse.json(
      { assistantText: e?.message ?? "Failed", toolCalls: [], requestId } satisfies ChatApiResponse,
      { status: 500 }
    );
  }
}
