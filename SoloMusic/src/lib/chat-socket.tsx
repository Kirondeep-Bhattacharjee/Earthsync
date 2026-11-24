import * as React from "react"
import { Outlet } from "react-router-dom"
import { useAuth } from "@/lib/auth"

/* ------------------------------------------------------------------ */
/* Protocol (mirrors backend/src/lib/socket.ts)                        */
/* ------------------------------------------------------------------ */

// Signed URLs for one photo or voice note. They expire after 30 to 45 minutes,
// so a page that stays open refetches (see refreshMedia in chat-thread.tsx).


// Delivery state of one of MY messages. It only ever moves forward.


export type ChatMedia = {
  url: string
  thumbUrl: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  // About 48 peaks (0-255) for voice notes, null for photos and old notes.
  waveform: number[] | null
}

// Delivery state of one of MY messages. It only ever moves forward.
export type ReceiptStatus = "sent" | "delivered" | "read"

export type ChatMessage = {
  id: number
  kind: "text" | "image" | "voice"
  body: string | null // null for photos, voice notes and deleted messages
  media: ChatMedia | null
  createdAt: string
  fromMe: boolean
  status: ReceiptStatus | null // only for my own messages
  deleted: boolean // deleted for everyone: body and media are null
}

export type ServerEvent =
  | { type: "ready" }
  | { type: "ack"; clientId?: string; id: number }
  | { type: "message"; username: string; chatMessage: ChatMessage }
  // My messages in the thread with `username`, up to id `upToId`, reached
  // `status`. "read" is only sent when both people have read receipts on.
  | {
      type: "receipt"
      username: string
      status: "delivered" | "read"
      upToId: number
    }
  // A message in the thread with `username` was deleted. "me" removes it,
  // "everyone" turns it into a placeholder.
  | {
      type: "message_deleted"
      username: string
      id: number
      scope: "me" | "everyone"
    }
  | { type: "error"; status: number; message: string; clientId?: string }

export type ConnectionStatus = "connecting" | "open" | "closed"

type Listener = (event: ServerEvent) => void

type ChatSocketValue = {
  status: ConnectionStatus
  // Goes up by one each time the socket comes back after a drop, so pages can
  // refetch whatever they missed while it was down.
  reconnectCount: number
  // Returns false when the socket is not ready, so the caller can mark the
  // message as failed instead of waiting for an ack that will never come.
  send: (username: string, body: string, clientId: string) => boolean
  // Returns the unsubscribe function.
  subscribe: (listener: Listener) => () => void
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const API_URL = import.meta.env.VITE_API_URL ?? ""

// If the server does not say "ready" in this time, treat the attempt as failed.
const READY_TIMEOUT_MS = 10_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

// Close code the server uses when the session was destroyed.
const SIGNED_OUT_CODE = 4401

// Close code the server uses when the account must re-accept the Terms or give
// a date of birth (see recheckSession in backend/src/lib/socket.ts).
const ONBOARDING_REQUIRED_CODE = 4403

function socketUrl(): string {
  const base = API_URL || window.location.origin
  return `${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws`
}

function parseEvent(raw: unknown): ServerEvent | null {
  if (typeof raw !== "string") {
    return null
  }

  try {
    const json = JSON.parse(raw) as { type?: unknown }

      if (
      json.type === "ready" ||
      json.type === "ack" ||
      json.type === "message" ||
      json.type === "receipt" ||
      json.type === "message_deleted" ||
      json.type === "error"
    ) {
      return json as ServerEvent
    }
  } catch {
    // Ignore frames that are not valid JSON.
  }

  return null
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

const ChatSocketContext = React.createContext<ChatSocketValue | null>(null)

export function useChatSocket(): ChatSocketValue {
  const value = React.useContext(ChatSocketContext)

  if (!value) {
    throw new Error("useChatSocket must be used inside ChatSocketProvider")
  }

  return value
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

// A layout route: one WebSocket per signed-in session, shared by every page
// below it. Place it between ProtectedRoute and SyncLayout in App.tsx.
export function ChatSocketProvider() {
  const { user, refresh } = useAuth()
  const userId = user?.id

  const [status, setStatus] = React.useState<ConnectionStatus>("connecting")
  const [reconnectCount, setReconnectCount] = React.useState(0)

  const socketRef = React.useRef<WebSocket | null>(null)
  const readyRef = React.useRef(false)
  const listenersRef = React.useRef(new Set<Listener>())
  const refreshRef = React.useRef(refresh)

  React.useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  React.useEffect(() => {
    if (userId === undefined) {
      return
    }

    let stopped = false
    let attempt = 0
    let everReady = false
    let retryTimer: number | undefined
    let readyTimer: number | undefined

    // Only a 401 from the server means the session is gone. A network error or
    // a 5xx must never sign anyone out. On a real 401, refresh() makes
    // AuthProvider drop the user and ProtectedRoute sends them to sign-in.
    async function sessionIsDead(): Promise<boolean> {
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          credentials: "include",
        })

        return response.status === 401
      } catch {
        return false
      }
    }

    function scheduleRetry() {
      if (stopped) {
        return
      }

      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
      attempt += 1

      // Jitter, so a server restart does not bring every tab back at once.
      const jittered = delay / 2 + Math.random() * (delay / 2)

      retryTimer = window.setTimeout(connect, jittered)
    }

    async function handleClosed(code: number, reachedReady: boolean) {
      setStatus("closed")

      if (stopped) {
        return
      }

      // Consents are out of date: refresh auth so ProtectedRoute sees
      // onboardingRequired and redirects to /onboarding. No retry needed, the
      // server would refuse the socket until onboarding is finished.
      if (code === ONBOARDING_REQUIRED_CODE) {
        void refreshRef.current()
        return
      }

      if (code === SIGNED_OUT_CODE || !reachedReady) {
        if (await sessionIsDead()) {
          if (!stopped) {
            void refreshRef.current()
          }

          return
        }
      }

      scheduleRetry()
    }

    function connect() {
      if (stopped) {
        return
      }

      window.clearTimeout(retryTimer)
      setStatus("connecting")

      const ws = new WebSocket(socketUrl())
      socketRef.current = ws
      readyRef.current = false
      let reachedReady = false

      // A server that accepts the connection but never answers.
      readyTimer = window.setTimeout(() => {
        if (!reachedReady) {
          ws.close()
        }
      }, READY_TIMEOUT_MS)

      ws.onmessage = (message) => {
        if (socketRef.current !== ws) {
          return
        }

        const event = parseEvent(message.data)

        if (!event) {
          return
        }

        if (event.type === "ready") {
          reachedReady = true
          readyRef.current = true
          attempt = 0
          window.clearTimeout(readyTimer)
          setStatus("open")

          if (everReady) {
            setReconnectCount((count) => count + 1)
          }

          everReady = true
        }

        for (const listener of listenersRef.current) {
          listener(event)
        }
      }

      ws.onclose = (event) => {
        console.log("ws closed", event.code, event.reason, "reachedReady:", reachedReady)
        window.clearTimeout(readyTimer)

        // A stale socket (replaced or cleaned up) must not touch state.
        if (socketRef.current !== ws) {
          return
        }

        socketRef.current = null
        readyRef.current = false
        void handleClosed(event.code, reachedReady)
      }

      // The close event always follows an error, so it is handled there.
      ws.onerror = () => {}
    }

    // Coming back online or returning to the tab should not wait out a long backoff.
    function retryNow() {
      if (stopped || socketRef.current) {
        return
      }

      attempt = 0
      connect()
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        retryNow()
      }
    }

    window.addEventListener("online", retryNow)
    document.addEventListener("visibilitychange", onVisible)

    connect()

    return () => {
      stopped = true
      window.clearTimeout(retryTimer)
      window.clearTimeout(readyTimer)
      window.removeEventListener("online", retryNow)
      document.removeEventListener("visibilitychange", onVisible)

      const ws = socketRef.current
      socketRef.current = null
      readyRef.current = false

      if (ws) {
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null

        // Closing a socket that is still connecting logs a browser warning, so
        // let it open first and close it right away.
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = () => ws.close(1000)
        } else {
          ws.close(1000)
        }
      }
    }
  }, [userId])

  const send = React.useCallback(
    (username: string, body: string, clientId: string) => {
      const ws = socketRef.current

      if (!ws || !readyRef.current || ws.readyState !== WebSocket.OPEN) {
        return false
      }

      ws.send(JSON.stringify({ type: "send", clientId, username, body }))
      return true
    },
    []
  )

  const subscribe = React.useCallback((listener: Listener) => {
    listenersRef.current.add(listener)

    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const value = React.useMemo(
    () => ({ status, reconnectCount, send, subscribe }),
    [status, reconnectCount, send, subscribe]
  )

  return (
    <ChatSocketContext.Provider value={value}>
      <Outlet />
    </ChatSocketContext.Provider>
  )
}