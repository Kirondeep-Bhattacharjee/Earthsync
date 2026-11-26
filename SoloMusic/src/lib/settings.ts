// Talks to GET and PATCH /api/settings (backend/src/routes/settings.ts).

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

export type Settings = {
  // When off, you can't see when others read your messages, and they can't
  // see when you read theirs.
  readReceipts: boolean
}

// Carries a message that is safe to show to the person.
export class SettingsError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "SettingsError"
    this.status = status
  }
}

const SESSION_EXPIRED = "Your session has expired. Sign in again."

export async function fetchSettings(signal?: AbortSignal): Promise<Settings> {
  const response = await fetch(`${API_URL}/api/settings`, {
    credentials: "include",
    signal,
  })

  if (response.status === 401) {
    throw new SettingsError(SESSION_EXPIRED, 401)
  }

  if (!response.ok) {
    throw new SettingsError("Could not load your settings.", response.status)
  }

  return (await response.json()) as Settings
}

// Returns the values the server saved.
export async function updateSettings(patch: Settings): Promise<Settings> {
  let response: Response

  try {
    response = await fetch(`${API_URL}/api/settings`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  } catch {
    throw new SettingsError(
      "Could not reach the server. Check your connection and try again.",
      0
    )
  }

  if (response.status === 401) {
    throw new SettingsError(SESSION_EXPIRED, 401)
  }

  if (!response.ok) {
    throw new SettingsError("Could not save your settings. Try again.", response.status)
  }

  return (await response.json()) as Settings
}