// Base URL of your Express server. Set VITE_API_URL in the frontend .env for production.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:6000"

export type AuthUser = {
  id: number
  username: string
  email: string
}

export class ApiError extends Error {
  status: number
  fieldErrors: Record<string, string>

  constructor(
    status: number,
    message: string,
    fieldErrors: Record<string, string> = {}
  ) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

type RequestOptions = {
  method?: "GET" | "POST"
  body?: unknown
}

// Calls the backend under /api. Sends the session cookie (credentials: "include")
// and turns error responses into an ApiError with per-field messages.
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers:
        options.body !== undefined
          ? { "Content-Type": "application/json" }
          : undefined,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new ApiError(
      0,
      "Could not reach the server. Check your connection and try again."
    )
  }

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const fieldErrors: Record<string, string> = {}

    // 400: { errors: [{ field, message }] }
    if (Array.isArray(data.errors)) {
      for (const item of data.errors) {
        if (item?.field && !fieldErrors[item.field]) {
          fieldErrors[item.field] = item.message
        }
      }
    }

    // 409: { field, message }
    if (typeof data.field === "string" && data.field !== "unknown") {
      fieldErrors[data.field] = data.message
    }

    throw new ApiError(
      response.status,
      data.message ?? "Something went wrong. Please try again.",
      fieldErrors
    )
  }

  return data as T
}