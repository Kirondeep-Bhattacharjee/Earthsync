// Talks to the disappearing-messages endpoint
// (backend/src/routes/chat-settings.ts). One timer per chat, shared by both
// people. It only affects messages sent after it was changed.

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

// Same list as the backend (backend/src/lib/disappearing.ts). null = off.
export const DISAPPEAR_CHOICES: { seconds: number | null; label: string }[] = [
  { seconds: null, label: "Off" },
  { seconds: 24 * 60 * 60, label: "24 hours" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days" },
  { seconds: 90 * 24 * 60 * 60, label: "90 days" },
]

// "24 hours", "7 days", ... or "Off".
export function disappearLabel(seconds: number | null): string {
  return (
    DISAPPEAR_CHOICES.find((choice) => choice.seconds === seconds)?.label ??
    "Off"
  )
}

// Carries a message that is safe to show to the person.
export class DisappearError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "DisappearError"
    this.status = status
  }
}

export async function setDisappearing(
  username: string,
  afterSeconds: number | null
): Promise<void> {
  let response: Response

  try {
    response = await fetch(
      `${API_URL}/api/conversations/${encodeURIComponent(username)}/disappearing`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ afterSeconds }),
      }
    )
  } catch {
    throw new DisappearError(
      "Could not reach the server. Check your connection and try again.",
      0
    )
  }

  if (response.ok) {
    return
  }

  // 409 carries a useful sentence ("Send a message first ...").
  if (response.status === 409) {
    const data = (await response.json().catch(() => null)) as {
      message?: string
    } | null

    throw new DisappearError(
      data?.message ?? "Send a message first, then turn this on.",
      409
    )
  }

  throw new DisappearError(
    "Could not change disappearing messages. Try again.",
    response.status
  )
}
