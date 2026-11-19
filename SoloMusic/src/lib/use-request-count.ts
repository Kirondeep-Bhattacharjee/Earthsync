import { useCallback, useEffect, useState } from "react"
import { useLocation } from "react-router-dom"

const API_URL = import.meta.env.VITE_API_URL ?? ""
const CHANGED_EVENT = "requests:changed"

// Call after accepting, declining, cancelling or sending a request so the
// sidebar badge refreshes without waiting for the next navigation.
export function notifyRequestsChanged() {
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

// Number of incoming friend requests, for the sidebar badge.
export function useRequestCount() {
  const [count, setCount] = useState(0)
  const { pathname } = useLocation()

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_URL}/api/friend-requests/count`, {
        credentials: "include",
        signal,
      })
      if (!res.ok) return

      const data = await res.json()
      if (typeof data.incoming === "number") setCount(data.incoming)
    } catch {
      // Keep the previous count: a badge is not worth an error state.
    }
  }, [])

  // Refetch on every navigation, so a request that arrived meanwhile shows up.
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [pathname, refresh])

  useEffect(() => {
    const onChange = () => void refresh()
    window.addEventListener(CHANGED_EVENT, onChange)
    window.addEventListener("focus", onChange)
    return () => {
      window.removeEventListener(CHANGED_EVENT, onChange)
      window.removeEventListener("focus", onChange)
    }
  }, [refresh])

  return count
}