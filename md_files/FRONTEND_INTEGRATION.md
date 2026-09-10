# Frontend Integration Guide for Chatbot

This guide explains how to integrate the document-grounded chatbot into a frontend application. It is intended as the single source of truth for frontend developers building the chat interface.

The API relies on an API key that identifies the **workspace**, not the end-user. This means visitors to your site do not need to log in to chat.

## 1. Authentication

All public API endpoints require a workspace API key. The key should be passed via HTTP headers using either `X-Api-Key` or standard Bearer authorization.

```http
X-Api-Key: pk_live_...
```
*or*
```http
Authorization: Bearer pk_live_...
```

**Security Note**: Because this key identifies the workspace and is used by unauthenticated visitors, it is **safe to expose in your frontend JavaScript bundle**. Origin protection, rate limiting, and quotas are enforced on the backend to prevent abuse.

---

## 2. API Endpoints

The integration involves two endpoints:
1. `GET /api/public/config` (Initialization & Limits)
2. `POST /api/public/chat` (Sending queries & Receiving answers)

### 2.1 Initialization (`GET /api/public/config`)

Fetch this endpoint once when the chatbox mounts. It returns the workspace's configured widget theme, capability flags, and enforced character/turn limits.

**Request**
```http
GET /api/public/config
X-Api-Key: <your_api_key>
```

**Response** (`200 OK`)
```json
{
  "success": true,
  "workspace": {
    "name": "Acme Corp Docs"
  },
  "widget": {
    // Customization values configured by the workspace owner
    "theme": "light",
    "primaryColor": "#3b82f6",
    "sourceMode": "labels" // "full", "labels", or "hidden"
  },
  "limits": {
    "maxQueryLength": 1000,
    "maxHistoryTurns": 6
  },
  "capabilities": {
    "filterByDocument": false // true if the API key has 'chat:filter' scope
  }
}
```

**Frontend Behavior Requirements:**
- Use `maxQueryLength` to enforce input character limits in the textarea.
- Use `maxHistoryTurns` to determine how much of the conversation to retain and send in subsequent requests.

---

### 2.2 Sending Messages (`POST /api/public/chat`)

This endpoint processes the visitor's query, retrieves context, and returns the AI's response. It supports both standard JSON responses and Server-Sent Events (SSE) for streaming.

**Request**
```http
POST /api/public/chat
Content-Type: application/json
X-Api-Key: <your_api_key>
```

**Payload Payload**
```json
{
  "query": "How do I reset my password?", // Required. Must not exceed maxQueryLength.
  "stream": true, // Optional. Set to true for SSE streaming. Default is false.
  "sessionId": "visitor-abc-123", // Optional. Alphanumeric tracking ID (max 64 chars).
  "topK": 4, // Optional. Max retrieval documents (bounded by server, max 6).
  "history": [ // Optional. Previous conversation context.
    { "role": "user", "content": "I need help with my account." },
    { "role": "assistant", "content": "Sure, what do you need help with?" }
  ],
  "documentIds": ["uuid-1", "uuid-2"] // Optional. Max 20. Only works if filterByDocument capability is true.
}
```

#### Non-Streaming Response (`stream: false`)

**Response** (`200 OK`)
```json
{
  "success": true,
  "answer": "To reset your password, visit the settings page...",
  "sources": [
    { "id": "...", "title": "Account Setup", "snippet": "..." }
  ],
  "citedSources": ["id1", "id2"], // Document IDs the model actually used
  "chunksUsed": 3
}
```

#### Streaming Response (`stream: true`)

When streaming, the server responds with `Content-Type: text/event-stream`. The frontend must parse SSE events as they arrive.

**Event Types:**
- `event: sources` — Fired first. Contains retrieved sources context.
  ```json
  {"sources": [...], "chunksUsed": 3}
  ```
- `event: chunk` — Fired continuously as the LLM generates tokens.
  ```json
  {"content": "To reset your password"}
  ```
- `event: done` — Fired when generation naturally concludes.
  ```json
  {"success": true}
  ```
- `event: error` — Fired if a failure occurs mid-stream.
  ```json
  {"error": "An error occurred while generating the answer."}
  ```

---

## 3. Rate Limiting, Quotas, and Headers

The server tracks rate limits per API key, per visitor IP, and by daily global quota. The backend exposes standard rate-limiting headers on every request.

**Exposed Headers:**
- `RateLimit-Limit`: Requests allowed per window.
- `RateLimit-Remaining`: Requests remaining in the current window.
- `RateLimit-Reset`: Time in seconds until the rate limit resets.
- `Retry-After`: Time in seconds to wait before trying again (if rate limited).
- `X-Quota-Limit`: Daily quota of messages allowed.
- `X-Quota-Remaining`: Daily quota of messages remaining.

---

## 4. Error Handling

A robust chatbox must handle all API failure states gracefully. 

| Status Code | Code | Reason | Expected Frontend Behavior |
| --- | --- | --- | --- |
| **400** | `QUERY_REQUIRED`, `QUERY_TOO_LONG` | Payload validation failed. | Display local validation message. Ensure JS enforces limits before submitting. |
| **401** | `API_KEY_MISSING`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED` | API key issues. | Show a fatal error. The widget should disable the input box. |
| **403** | `SCOPE_FORBIDDEN` | Missing required scope. | Log the error. Check key permissions. |
| **404** | `WORKSPACE_UNAVAILABLE` | Workspace deleted. | Show a fatal error. Disable the widget. |
| **429** | `RATE_LIMITED` | Visitor or Workspace rate limit hit. | Show warning: *"Sending too quickly. Wait a moment."* Backoff using `Retry-After` header. |
| **429** | `QUOTA_EXCEEDED` | Daily workspace limit hit. | Show message: *"This chat has reached its daily limit."* Disable input. |
| **503** | `SERVICE_UNAVAILABLE` | Dependent service down (e.g., Vector Store, LLM). | Show message: *"The assistant is temporarily unavailable. Please try again shortly."* |
| **504** | `TIMEOUT` | Request took too long to complete. | Show message: *"That took too long. Try a shorter or more specific question."* |
| **500** | `INTERNAL_ERROR` | Unknown backend error. | Show generic error message. |

*Error JSON structure:*
```json
{
  "success": false,
  "error": "Human readable message",
  "code": "API_KEY_INVALID"
}
```

---

## 5. UI/UX Implementation Requirements

### 5.1 Chat Interface State Management
1. **Loading State**: Disable the input box and show a loading indicator (e.g., pulsing dots or skeleton) as soon as the user presses Enter.
2. **Streaming Build-up**: If using `stream: true`, progressively append text to the active message bubble as `chunk` events arrive. Parse markdown to HTML on the fly.
3. **Empty Input**: Disable the send button if the textarea is empty or contains only whitespace.
4. **Auto-Scroll**: Automatically scroll to the bottom of the chat container as new messages or streaming chunks arrive.

### 5.2 Context & History
1. **Manage History Limits**: Store the conversation history locally. When sending a new request, only include the most recent `N` turns (where `N` is `limits.maxHistoryTurns` from the config API).
2. **History Truncation**: To prevent bloated requests, do not pass system messages or UI error messages back to the API. Only pass `{"role": "user", "content": "..."}` and `{"role": "assistant", "content": "..."}` pairs.
3. **Session ID**: Generate a unique alphanumeric ID (e.g., `crypto.randomUUID()`) when the session starts and pass it in `sessionId` for all queries. This groups logs correctly on the backend.

### 5.3 Sources & Citations
1. The backend returns a redacted `sources` array (based on the workspace's `sourceMode`).
2. Only render citations or source cards if the `sources` array is non-empty. 
3. *Note*: The server handles the redaction automatically. The frontend should just render whatever `title`, `snippet`, or `labels` it receives in the payload.

---

## 6. Complete Vanilla JS Example (Streaming)

Here is a drop-in integration example parsing the SSE stream and enforcing basic history rules.

```javascript
class ChatbotClient {
  constructor(apiKey, apiUrl = '/api/public') {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.history = [];
    this.maxHistoryTurns = 6;
    this.sessionId = crypto.randomUUID();
  }

  async init() {
    const res = await fetch(`${this.apiUrl}/config`, {
      headers: { 'X-Api-Key': this.apiKey }
    });
    
    if (!res.ok) throw new Error('Failed to load widget config');
    
    const data = await res.json();
    this.maxHistoryTurns = data.limits.maxHistoryTurns || 6;
    return data;
  }

  async sendMessage(query, onChunk, onSources, onError, onDone) {
    this.history.push({ role: 'user', content: query });
    
    try {
      const response = await fetch(`${this.apiUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey
        },
        body: JSON.stringify({
          query,
          stream: true,
          sessionId: this.sessionId,
          // Only send the allowed number of previous turns
          history: this.history.slice(-(this.maxHistoryTurns + 1), -1) 
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || response.statusText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        const lines = chunkText.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          
          try {
            const data = JSON.parse(payload);
            const eventType = this.extractEvent(line, lines);

            if (eventType === 'sources' && onSources) {
              onSources(data.sources);
            } else if (eventType === 'chunk' && onChunk) {
              assistantMessage += data.content;
              onChunk(data.content);
            } else if (eventType === 'error' && onError) {
              throw new Error(data.error);
            } else if (eventType === 'done' && onDone) {
              onDone();
            }
          } catch (e) {
            // Ignore incomplete JSON chunks mid-stream
          }
        }
      }

      this.history.push({ role: 'assistant', content: assistantMessage });
    } catch (error) {
      if (onError) onError(error.message);
    }
  }

  extractEvent(currentLine, allLines) {
    // SSE structure is `event: name\ndata: {...}\n\n`
    // This is a simplified extraction for the example
    const eventIndex = allLines.indexOf(currentLine) - 1;
    if (eventIndex >= 0 && allLines[eventIndex].startsWith('event: ')) {
      return allLines[eventIndex].split('event: ')[1];
    }
    return 'chunk'; // Default if event line is missing
  }
}
```
