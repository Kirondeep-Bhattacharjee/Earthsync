import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import PostEngagement from "@/components/post-engagement"
import { formatDayLabel } from "@/lib/format-time"
import type { Post } from "@/lib/post-types"

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

type Props = {
  post: Post
  isOwner: boolean
  onClose: () => void
  onDeleted: (id: number) => void
}

function PostViewer({ post, isOwner, onClose, onDeleted }: Props) {
  const [isConfirming, setIsConfirming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setIsDeleting(true)
    setError(null)

    try {
      const response = await fetch(`${API_URL}/api/posts/${post.id}`, {
        method: "DELETE",
        credentials: "include",
      })

      if (response.status === 401) {
        setError("Your session has expired. Sign in again to delete this post.")
        return
      }

      // 404 means it is already gone, which is what the person wanted.
      if (!response.ok && response.status !== 404) {
        const data = (await response.json().catch(() => ({}))) as {
          message?: string
        }

        setError(data.message ?? "Could not delete this post. Try again.")
        return
      }

      onDeleted(post.id)
    } catch {
      setError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setIsDeleting(false)
      setIsConfirming(false)
    }
  }

  const { media } = post

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !isDeleting) onClose()
      }}
    >
      {/* max-h and overflow-y-auto: the likes and comments make the dialog taller than a screen. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogTitle className="sr-only">
          {media.type === "video" ? "Video post" : "Photo post"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Posted {formatDayLabel(post.createdAt)}
        </DialogDescription>

        <div className="overflow-hidden rounded-md bg-muted">
          {media.type === "video" ? (
            <video
              src={media.url}
              poster={media.thumbUrl ?? undefined}
              controls
              autoPlay
              playsInline
              className="max-h-[70vh] w-full object-contain"
            />
          ) : (
            <img
              src={media.url}
              alt={post.caption ?? "Photo post"}
              className="max-h-[70vh] w-full object-contain"
            />
          )}
        </div>

        <div className="flex flex-col gap-3">
          {post.caption && (
            <p className="max-w-prose break-words whitespace-pre-wrap">
              {post.caption}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <time
              dateTime={post.createdAt}
              className="text-sm text-muted-foreground"
            >
              {formatDayLabel(post.createdAt)}
            </time>

            {isOwner &&
              (isConfirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">Delete this post?</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => setIsConfirming(false)}
                  >
                    Keep
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => void handleDelete()}
                  >
                    {isDeleting ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setIsConfirming(true)}
                >
                  Delete
                </Button>
              ))}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="border-t pt-3">
            <PostEngagement
              key={post.id}
              postId={post.id}
              onNavigate={onClose}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default PostViewer