import { useCallback, useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import { useChatSocket } from "@/lib/chat-socket"

const API_URL = import.meta.env.VITE_API_URL ?? ""

// Fired after anything that changes what is unread (opening a thread marks it
// read), so the sidebar badge updates at once.
export function notifyUnreadChanged() {
  window.dispatchEvent(new Event("chats:unread-changed"))
}

// Number of friend threads with unread messages, for the sidebar badge.
// Messages from people who are not friends are not counted here: they are
// highlighted in the Public tab instead.
//
// Must be used under ChatSocketProvider. Refetches on navigation, window focus,
// notifyUnreadChanged(), a live message from someone else, and a socket
// reconnect. On failure it keeps the previous number.
export function useUnreadCount(): number {
  const { pathname } = useLocation()
  const { reconnectCount, subscribe } = useChatSocket()
  const [count, setCount] = useState(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations/unread-count`, {
        credentials: "include",
        signal,
      })

      if (!response.ok) {
        return
      }

      const data = (await response.json()) as { friends?: number }

      setCount(typeof data.friends === "number" ? data.friends : 0)
    } catch {
      // Keep the previous count.
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    void load(controller.signal)

    return () => controller.abort()
  }, [load, pathname, reconnectCount])

  useEffect(() => {
    const refresh = () => void load()

    window.addEventListener("focus", refresh)
    window.addEventListener("chats:unread-changed", refresh)

    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("chats:unread-changed", refresh)
    }
  }, [load])

  // A message from someone else may be a new unread one. The server decides
  // whether it counts (friend or not, and whether the thread is hidden).
  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "message" && !event.chatMessage.fromMe) {
        void load()
      }
    })
  }, [subscribe, load])

  return count
}