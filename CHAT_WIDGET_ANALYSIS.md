# ChatWidget Component Analysis

## 📍 Location
- **File**: [components/chat_widget.tsx](components/chat_widget.tsx)
- **Type**: React client component ("use client")
- **Lines**: ~2000+ lines

---

## 🏗️ Architecture Overview

The ChatWidget uses a **three-tier message processing system**:

```
ChatWidget (Client)
      ↓
/api/chat (Main Handler)
      ↓
Gemini AI (Intent Analysis)
      ↓
Database Operations (Supabase)
```

---

## 1️⃣ ChatWidget Component (`components/chat_widget.tsx`)

### Key Responsibilities:
- **UI Layer**: Message input/output, file upload, voice input
- **Message History Management**: Tracks chat messages with conversation state
- **Tool Execution**: Handles tool calls from the server (create/update/delete operations)
- **Recent Entities Memory**: Tracks last created task/event/goal for context

### State Management:
```typescript
const [chat, setChat] = useState<ChatMessage[]>([
  { role: "assistant", content: "Hey 👋 Tell me what you want in natural language..." }
]);
const [input, setInput] = useState("");
const [loading, setLoading] = useState(false);
const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
const executedToolCallIdsRef = useRef<Set<string>>(new Set()); // Idempotency check
```

### Message Flow:
1. User enters text → `handleSendMessage()`
2. Sends to `/api/chat` with message & context
3. Receives `ChatApiResponse` with:
   - `assistantText` - Response to show user
   - `toolCalls` - List of tools to execute (create_task, create_event, etc.)
   - `requestId` - For tracking & idempotency
   - `silentMode` - If true, show toast instead of assistant message
   - `successMessage` - Plain toast message

### Tool Execution:
```typescript
const toolCalls = [
  { name: "create_task", arguments: { title: "...", dueDate: "...", priority: "..." } },
  { name: "set_active_view", arguments: { view: "calendar" } },
  { name: "request_disambiguation", arguments: { ... } }
]
```

Each tool is executed with **idempotency guarantee** (checks `executedToolCallIds` to prevent double execution).

---

## 2️⃣ Intent Analysis Flow

### Entry Point: `/api/chat/route.ts` (Main POST Handler)

#### Step 1: Message Normalization
```typescript
function normalizeUserTextForLLM(input: string): string {
  // "tmrw" → "tomorrow", "2pm" → "2 pm", "tdy" → "today"
}
```

#### Step 2: Gemini AI Analysis (Using `gemini-2.5-flash`)

The system sends a **detailed planner prompt** to Gemini:

```typescript
const plannerSystem = `
You are an intelligent personal assistant that converts casual user messages into structured tasks/goals/events.
Analyze:
- Task: "buy groceries" → { kind: "task", title: "Buy groceries" }
- Goal: "learn coding" → { kind: "goal", title: "Learn coding" }
- Event: "meeting tomorrow 9am" → { kind: "event", date: "2026-03-24", time: "09:00" }

Output JSON with:
{
  "assistantText": "What you'll say to the user",
  "items": [
    { kind: "create_task", title: "...", dueDate: "...", priority: "..." },
    { kind: "create_event", title: "...", date: "...", time: "..." }
  ]
}
`;
```

#### Step 3: System Processes Planner Output

1. **Deduplication**: Filters duplicate items within same response
2. **Conflict Detection**: Checks calendar for conflicts
3. **Disambiguation**: If multiple matches found, asks user to pick
4. **Recent Entity Fixing**: Uses memory to resolve ambiguous references ("it" → last task title)

### Type Determination Rules:

```
TASK:  Simple action without scheduling keywords
EVENT: Has date/time keywords (meeting, schedule, appointment) OR date mentioned
GOAL:  Learning, improving, building habits (learn, improve, practice, habit)
```

### Examples from prompt:
```
"buy groceries" → task
"do homework at 1pm" → task (has time but no scheduling keywords)
"Create goal to run 6k everyday" → goal
"meeting tomorrow at 7pm" → event
"birthday friday" → event (has date)
```

---

## 3️⃣ Fallback Intent Analysis (Without Gemini)

If Gemini API fails, the system falls back to **regex-based parsing**:

**File**: [app/api/webhooks/bloo/route.ts](app/api/webhooks/bloo/route.ts) - `parseMessageIntent()` function

```typescript
function parseMessageIntent(text: string): AIAnalysisResult {
  // 1. Remove action phrases: "create task", "remind me"
  let cleaned = text
    .replace(/\b(create\s+(task|goal|event))\b/gi, "")
    .replace(/\b(remind\s+me)\b/gi, "");

  // 2. Detect patterns
  const timeMatch = cleaned.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  const hasDate = /\b(monday|tomorrow|today)\b/i.test(cleaned);
  const isGoal = /\b(learn|study|improve|practice|achieve)\b/i.test(cleaned);
  const hasSchedulingKeyword = /\b(meeting|appointment|schedule)\b/i.test(cleaned);

  // 3. Determine type
  if (isGoal && !hasDate) type = "goal";
  else if (hasSchedulingKeyword || hasDate) type = "event";
  else type = "task";

  // 4. Extract date & time using hardcoded logic
  // 5. Build title from cleaned text
}
```

---

## 4️⃣ Task/Goal/Event Creation

### Task Creation Path:
```typescript
// /api/chat/route.ts processes:
if (item.kind === "task") {
  pushClient({
    name: "create_task",
    arguments: {
      title: "Buy milk",
      notes: "From chat",
      dueDate: null,
      dueTime: null,
      priority: "medium",
      listName: "Personal" // Inferred from heuristics
    }
  });
}
```

### Event Creation Path:
```typescript
if (item.kind === "event") {
  // Validates date exists (required for events)
  // Carries forward time from chat history if missing
  pushClient({
    name: "create_event",
    arguments: {
      title: "Meeting",
      date: "2026-03-24",
      time: "09:00",
      endTime: null
    }
  });
}
```

### Goal Creation Path:
```typescript
if (item.kind === "goal") {
  pushClient({
    name: "create_goal",
    arguments: {
      title: "Learn JavaScript",
      description: "From chat",
      targetDate: null
    }
  });
}
```

---

## 5️⃣ Server Responses to User

### Response Types:

#### 1. **Silent Mode** (Routine creation)
```typescript
if (isSilentOperation) {
  // All tool calls are create_* actions
  return {
    assistantText: "",
    silentMode: true,
    successMessage: "✓ Task added",  // Toast instead of message
    toolCalls: [...]
  };
}
```

#### 2. **Explicit Response** (Query/complex action)
```typescript
return {
  assistantText: "Here's your agenda:\n• 09:00–10:00 — Team meeting\n• ...",
  toolCalls: [{ name: "set_active_view", arguments: { view: "calendar" } }],
  requestId: rid
};
```

#### 3. **Conflict Detection**
```typescript
return {
  assistantText: `That time conflicts with your calendar on 2026-03-24 (09:00)...
Suggested open slots:
• 10:00–11:00 (Exact match)
• 14:00–15:00 (Available)`,
  toolCalls: [...] // Tools to set view + handle disambiguation
};
```

#### 4. **Disambiguation** (Multiple matches)
```typescript
return {
  assistantText: "",
  toolCalls: [{
    name: "request_disambiguation",
    arguments: {
      prompt: "I found multiple events matching 'meeting'. Which one?",
      kind: "event",
      choices: [
        { key: "evt_123", title: "Team Meeting", subtitle: "2026-03-24 • 09:00–10:00" },
        { key: "evt_456", title: "1-on-1 Meeting", subtitle: "2026-03-25 • 14:00–15:00" }
      ],
      pendingTool: { ... } // Original tool to execute after choice
    }
  }]
};
```

### Default Messages:
```typescript
"Done — I've handled that."  // Generic success
"I couldn't parse that cleanly. Try: 'meet tomorrow 2pm with Rahul'"  // Parse error
"You have nothing scheduled today."  // Empty agenda
```

---

## 6️⃣ Webhook Integration (Bloo SMS)

**File**: [app/api/webhooks/bloo/route.ts](app/api/webhooks/bloo/route.ts)

The same intent analysis functions are reused for SMS messages:

```
SMS → normalizePhone() → analyzeMessageWithAI() → create task/goal/event
    → sendBlooMessage("✅ Task created: Buy milk")
```

### Responses Sent to User:
```
✅ Task created: Buy milk
🎯 Goal created: Learn JavaScript
📅 Event created: Meeting
⚠️ Need a date for: "Meeting" (e.g., "tomorrow" or "Friday")
```

---

## 7️⃣ Key Files Summary

| File | Purpose | Key Functions |
|------|---------|---|
| [components/chat_widget.tsx](components/chat_widget.tsx) | Chat UI & message handling | `handleSendMessage()`, tool execution, history management |
| [app/api/chat/route.ts](app/api/chat/route.ts) | Main chat API | Gemini planning, deduplication, conflict detection |
| [app/api/webhooks/bloo/route.ts](app/api/webhooks/bloo/route.ts) | SMS webhook | `analyzeMessageWithAI()`, `parseMessageIntent()`, SMS responses |
| [controllers/blooWebhookController.ts](controllers/blooWebhookController.ts) | Optional controller | Shared utilities (normalizePhone, sanitizeText) |

---

## 8️⃣ Intent Analysis - Key Takeaways

### AI Model Used:
- **Primary**: `gemini-2.5-flash` (fast, ~800ms response)
- **Fallback**: Regex/hardcoded parsing (if Gemini API unavailable)

### Configuration:
```env
AI_PROVIDER=gemini
GEMINI_API_KEY=AIzaSyAIYY6DuSVA-GqgRAwpkQQnuVAY4ff1KlU
```

### Intent Detection Logic:
1. **Preprocess**: Normalize text (fix typos, abbreviations)
2. **Analyze**: Send to Gemini with detailed prompt
3. **Parse Response**: Extract JSON with type, title, date, time
4. **Fallback**: Use regex patterns + hardcoded rules
5. **Post-process**: Fix ambiguous references, detect conflicts

### Supported Actions:
- ✅ Create tasks (with priority, due date, notes)
- ✅ Create goals (with target date)
- ✅ Create events (with date/time)
- ✅ Create task lists
- ✅ Update/complete/delete existing items
- ✅ Query agenda
- ✅ Find free time slots

---

## 9️⃣ User Response Patterns

### Successful Creation:
```
User: "Create task: Buy milk by Friday"
Bot: "✓ Task added" (toast) + tool calls to update UI
```

### With Conflicts:
```
User: "Meeting tomorrow 9am"
Bot: "That time conflicts with your calendar...
Suggested slots:
• 10:00–11:00 (Exact match)
• 14:00–15:00 (Available)"
```

### Query:
```
User: "What's on my calendar today?"
Bot: "Here's your agenda (today):
• 09:00–10:00 — Team meeting
• 14:00–15:00 — 1-on-1 with Rahul"
```

### Ambiguous:
```
User: "Update the meeting"
Bot: [Shows disambiguation picker with list of meetings]
```

---

## 🔟 Summary

**The ChatWidget is a sophisticated natural language interface** that:

1. **Accepts casual messages** ("buy milk tomorrow", "meeting Friday 2pm")
2. **Analyzes intent** using Gemini AI with detailed prompts + regex fallback
3. **Determines action type** (task/goal/event) based on patterns
4. **Executes database operations** through tool calls
5. **Returns appropriate responses** (silent toast, text, disambiguation prompts)
6. **Handles edge cases** (conflicts, ambiguity, missing dates)
7. **Maintains context** through recent entity memory
8. **Ensures reliability** with fallback parsing & error handling

The same intent analysis is reused for **SMS integration** (Bloo webhook), making the bot accessible across channels.
