import type { ChatMessage } from "@/lib/chat-socket"

// Same default as chat-thread.tsx (empty means "same origin", for a Vite proxy).
const API_URL = import.meta.env.VITE_API_URL ?? ""

export type AttachmentKind = "image" | "voice"

// Limits the server enforces (backend/src/lib/chat-media.ts). Checking here
// only saves a round trip; the server is what actually refuses.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
// Photos are resized to this on the server too, so sending less loses nothing.
const IMAGE_MAX_EDGE = 1600
const DOWNSCALE_ABOVE_BYTES = 1.5 * 1024 * 1024

export class UploadError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function fallbackMessage(status: number): string {
  if (status === 0) {
    return "Could not reach the server. Check your connection and retry."
  }

  if (status === 401) {
    return "Your session expired. Sign in again."
  }

  if (status === 403) {
    return "Photos and voice messages are only for friends."
  }

  if (status === 413) {
    return "That file is too large."
  }

  if (status === 429) {
    return "You are sending files too fast. Wait a moment and retry."
  }

  return "Could not send. Try again."
}

type UploadOptions = {
  username: string
  kind: AttachmentKind
  file: Blob
  fileName: string
  // 0 to 1, how much of the file has left the browser.
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

// POST /api/messages/attachment. XMLHttpRequest, not fetch, because fetch has
// no upload progress. Resolves with the saved message (same shape as history).
export function uploadAttachment(options: UploadOptions): Promise<ChatMessage> {
  const { username, kind, file, fileName, onProgress, signal } = options

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()

    form.append("username", username)
    form.append("kind", kind)
    form.append("file", file, fileName)

    xhr.open("POST", `${API_URL}/api/messages/attachment`)
    xhr.withCredentials = true
    xhr.responseType = "json"

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(event.loaded / event.total)
      }
    }

    xhr.onload = () => {
      const data = xhr.response as {
        chatMessage?: ChatMessage
        message?: string
      } | null

      if (xhr.status >= 200 && xhr.status < 300 && data?.chatMessage) {
        resolve(data.chatMessage)
        return
      }

      reject(
        new UploadError(
          xhr.status,
          typeof data?.message === "string" && data.message
            ? data.message
            : fallbackMessage(xhr.status)
        )
      )
    }

    xhr.onerror = () => reject(new UploadError(0, fallbackMessage(0)))
    xhr.onabort = () => reject(new UploadError(0, "Upload cancelled."))

    if (signal) {
      if (signal.aborted) {
        reject(new UploadError(0, "Upload cancelled."))
        return
      }

      signal.addEventListener("abort", () => xhr.abort(), { once: true })
    }

    xhr.send(form)
  })
}

// Phone photos are often over the 5 MB limit. The server shrinks them to 1600px
// anyway, so shrink first: a big photo then uploads fast and is never refused
// for its size. Best effort: any failure sends the original file unchanged.
export async function prepareImage(file: File): Promise<Blob> {
  try {
    if (typeof createImageBitmap === "undefined") {
      return file
    }

    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)

    if (longest <= IMAGE_MAX_EDGE && file.size <= DOWNSCALE_ABOVE_BYTES) {
      bitmap.close()
      return file
    }

    const scale = Math.min(1, IMAGE_MAX_EDGE / longest)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext("2d")

    if (!context) {
      bitmap.close()
      return file
    }

    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85)
    )

    // Keep the original if the result is not actually smaller.
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}
