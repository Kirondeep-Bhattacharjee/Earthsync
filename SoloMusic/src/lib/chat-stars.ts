// Talks to the star endpoints (backend/src/routes/chat-settings.ts). Stars are
// private: only the person who starred a message ever sees them.

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

// One starred message, as the Chat info panel needs it. Photos and voice notes
// have no text, only a kind.
export type StarredMessage = {
  id: number
  fromMe: boolean
  kind: "text" | "image" | "voice"
  body: string | null
  createdAt: string
  starredAt: string
  expiresAt: string | null // when it disappears (a star does not stop that)
}

// Carries a message that is safe to show to the person.
export class StarError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "StarError"
    this.status = status
  }
}

export async function fetchStars(
  username: string,
  signal?: AbortSignal
): Promise<StarredMessage[]> {
  const response = await fetch(
    `${API_URL}/api/conversations/${encodeURIComponent(username)}/stars`,
    { credentials: "include", signal }
  )

  if (!response.ok) {
    throw new StarError("Could not load starred messages.", response.status)
  }

  const data = (await response.json()) as { stars?: StarredMessage[] }

  return data.stars ?? []
}

export async function setStarred(id: number, starred: boolean): Promise<void> {
  let response: Response

  try {
    response = await fetch(`${API_URL}/api/messages/${id}/star`, {
      method: starred ? "POST" : "DELETE",
      credentials: "include",
    })
  } catch {
    throw new StarError(
      "Could not reach the server. Check your connection and try again.",
      0
    )
  }

  if (response.ok) {
    return
  }

  throw new StarError(
    response.status === 401
      ? "Your session has expired. Sign in again."
      : response.status === 404
        ? "That message is no longer available."
        : starred
          ? "Could not star the message. Try again."
          : "Could not unstar the message. Try again.",
    response.status
  )
}
