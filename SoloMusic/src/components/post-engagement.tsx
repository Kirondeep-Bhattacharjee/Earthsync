import { useEffect, useState } from "react"
import { IconHeart, IconHeartFilled, IconMessageCircle } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import PostComments from "@/components/post-comments"
import {
  fetchEngagement,
  isAbortError,
  likePost,
  messageOf,
  unlikePost,
  type Engagement,
} from "@/lib/post-engagement"

type PostEngagementProps = {
  postId: number
  // Called when a profile link inside the comments is clicked, so the viewer
  // can close itself before the page changes.
  onNavigate?: () => void
}

type LoadState = "loading" | "ready" | "error"

// Render with key={post.id} so switching posts resets all state.
export default function PostEngagement({
  postId,
  onNavigate,
}: PostEngagementProps) {
  const [state, setState] = useState<LoadState>("loading")
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [engagement, setEngagement] = useState<Engagement | null>(null)
  const [likePending, setLikePending] = useState(false)
  const [likeError, setLikeError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState("loading")

    void (async () => {
      try {
        const data = await fetchEngagement(postId, controller.signal)
        setEngagement(data)
        setState("ready")
      } catch (err) {
        if (isAbortError(err)) {
          return
        }
        setError(messageOf(err))
        setState("error")
      }
    })()

    return () => controller.abort()
  }, [postId, attempt])

  async function toggleLike() {
    // One request at a time: a second click while one is in flight is ignored,
    // so fast clicking can never queue up extra likes.
    if (!engagement || likePending) {
      return
    }

    const before = engagement
    const wasLiked = before.likedByMe

    setLikePending(true)
    setLikeError(null)
    setEngagement({
      ...before,
      likedByMe: !wasLiked,
      likeCount: Math.max(0, before.likeCount + (wasLiked ? -1 : 1)),
    })

    try {
      const result = await (wasLiked ? unlikePost(postId) : likePost(postId))
      // The server's count is the truth (other people may have liked too).
      setEngagement((current) =>
        current
          ? { ...current, likedByMe: result.liked, likeCount: result.likeCount }
          : current
      )
    } catch (err) {
      setEngagement((current) =>
        current
          ? {
              ...current,
              likedByMe: before.likedByMe,
              likeCount: before.likeCount,
            }
          : current
      )
      setLikeError(messageOf(err))
    } finally {
      setLikePending(false)
    }
  }

  function changeCommentCount(delta: number) {
    setEngagement((current) =>
      current
        ? { ...current, commentCount: Math.max(0, current.commentCount + delta) }
        : current
    )
  }

  if (state === "loading") {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading likes and comments</span>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (state === "error" || !engagement) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {error ?? "Could not load likes and comments."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Try again
        </Button>
      </div>
    )
  }

  const liked = engagement.likedByMe

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        {/* The heart is the action; the count next to it is display text, not
            part of the click target. */}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void toggleLike()}
            disabled={likePending}
            aria-pressed={liked}
            aria-label={liked ? "Unlike this post" : "Like this post"}
            className={liked ? "text-destructive" : undefined}
          >
            {liked ? <IconHeartFilled /> : <IconHeart />}
          </Button>
          <span className="text-sm text-muted-foreground">
            {engagement.likeCount}{" "}
            {engagement.likeCount === 1 ? "like" : "likes"}
          </span>
        </div>
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          <IconMessageCircle className="size-4" aria-hidden="true" />
          {engagement.commentCount}{" "}
          {engagement.commentCount === 1 ? "comment" : "comments"}
        </span>
      </div>
      {likeError ? (
        <p role="alert" className="text-sm text-destructive">
          {likeError}
        </p>
      ) : null}
      <PostComments
        key={postId}
        postId={postId}
        onCountChange={changeCommentCount}
        onNavigate={onNavigate}
      />
    </div>
  )
}
