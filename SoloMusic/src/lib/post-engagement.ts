// Types and API calls for likes and comments. Use the same API_URL source as
// the other components if the project exports one.
const API_URL = import.meta.env.VITE_API_URL ?? ""

export const COMMENT_MAX_LENGTH = 500

export type Engagement = {
  likeCount: number
  likedByMe: boolean
  commentCount: number
}

export type LikeResult = {
  liked: boolean
  likeCount: number
}

export type PostComment = {
  id: number
  parentId: number | null
  body: string
  createdAt: string
  replyCount: number
  author: { username: string; profilePictureUrl: string | null }
  isMine: boolean
  canDelete: boolean
}

export type CommentsPage = {
  comments: PostComment[]
  nextCursor: number | null
}

export class EngagementError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

export function messageOf(error: unknown): string {
  return error instanceof EngagementError
    ? error.message
    : "Something went wrong. Try again."
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response

  try {
    res = await fetch(`${API_URL}/api${path}`, {
      credentials: "include",
      ...init,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new EngagementError(
      0,
      "Could not reach the server. Check your connection and try again."
    )
  }

  if (!res.ok) {
    let message = "Something went wrong. Try again."

    try {
      const data = (await res.json()) as { message?: unknown }
      if (typeof data.message === "string") {
        message = data.message
      }
    } catch {
      // Not JSON: keep the generic message.
    }

    if (res.status === 401) {
      message = "Your session expired. Sign in again."
    }

    throw new EngagementError(res.status, message)
  }

  return (await res.json()) as T
}

export function fetchEngagement(postId: number, signal?: AbortSignal) {
  return request<Engagement>(`/posts/${postId}/engagement`, { signal })
}

export function likePost(postId: number) {
  return request<LikeResult>(`/posts/${postId}/like`, { method: "POST" })
}

export function unlikePost(postId: number) {
  return request<LikeResult>(`/posts/${postId}/like`, { method: "DELETE" })
}

export function fetchComments(
  postId: number,
  options: { before?: number; after?: number; parent?: number },
  signal?: AbortSignal
) {
  const params = new URLSearchParams()
  if (options.before !== undefined) params.set("before", String(options.before))
  if (options.after !== undefined) params.set("after", String(options.after))
  if (options.parent !== undefined) params.set("parent", String(options.parent))

  const query = params.toString()
  return request<CommentsPage>(
    `/posts/${postId}/comments${query ? `?${query}` : ""}`,
    { signal }
  )
}

export function addComment(
  postId: number,
  body: string,
  parentId: number | null
) {
  return request<{ comment: PostComment }>(`/posts/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, parentId }),
  })
}

export function deleteComment(commentId: number) {
  return request<{ message: string; removed: number }>(
    `/comments/${commentId}`,
    { method: "DELETE" }
  )
}
