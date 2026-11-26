// Talks to the pin endpoints (backend/src/routes/chat-settings.ts).

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

// One pinned message, as the pinned bar needs it. Photos and voice notes have
// no text, only a kind.
export type PinnedMessage = {
  id: number
  fromMe: boolean
  kind: "text" | "image" | "voice"
  body: string | null
  createdAt: string
  pinnedAt: string
  expiresAt: string | null // when it disappears (a pin does not stop that)
}

// Carries a message that is safe to show to the person.
export class PinError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "PinError"
    this.status = status
  }
}

export async function fetchPins(
  username: string,
  signal?: AbortSignal
): Promise<PinnedMessage[]> {
  const response = await fetch(
    `${API_URL}/api/conversations/${encodeURIComponent(username)}/pins`,
    { credentials: "include", signal }
  )

  if (!response.ok) {
    throw new PinError("Could not load pinned messages.", response.status)
  }

  const data = (await response.json()) as { pins?: PinnedMessage[] }

  return data.pins ?? []
}

// The server's own message is used for the cases a person can act on (for
// example "You can pin up to 3 messages in a chat. Unpin one first.").
export async function setPinned(id: number, pinned: boolean): Promise<void> {
  let response: Response

  try {
    response = await fetch(`${API_URL}/api/messages/${id}/pin`, {
      method: pinned ? "POST" : "DELETE",
      credentials: "include",
    })
  } catch {
    throw new PinError(
      "Could not reach the server. Check your connection and try again.",
      0
    )
  }

  if (response.ok) {
    return
  }

  if (response.status === 401) {
    throw new PinError("Your session has expired. Sign in again.", 401)
  }

  const data = (await response.json().catch(() => null)) as {
    message?: unknown
  } | null

  throw new PinError(
    response.status === 409 && typeof data?.message === "string"
      ? data.message
      : pinned
        ? "Could not pin the message. Try again."
        : "Could not unpin the message. Try again.",
    response.status
  )
}
