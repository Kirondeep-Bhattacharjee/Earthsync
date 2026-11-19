import { useCallback, useEffect, useState } from "react"
import {
  IconPhoto,
  IconPlayerPlayFilled,
  IconPlus,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import PostUploadDialog from "@/components/post-upload-dialog"
import PostViewer from "@/components/post-viewer"
import type { Post, PostsPage } from "@/lib/post-types"

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

type LoadState =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "error"

type Props = {
  username: string
  // Owners can post and delete. Everyone else only views.
  isOwner: boolean
  // False when the viewer may not see posts (private profile, not a friend).
  canView: boolean
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return ""

  const minutes = Math.floor(seconds / 60)
  const rest = String(seconds % 60).padStart(2, "0")

  return `${minutes}:${rest}`
}

function PostsGridSkeleton() {
  return (
    <div
      className="grid grid-cols-3 gap-1.5"
      role="status"
      aria-label="Loading posts"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="aspect-square w-full rounded-md" />
      ))}
    </div>
  )
}

function ProfilePosts({ username, isOwner, canView }: Props) {
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [posts, setPosts] = useState<Post[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)

  const [isUploadOpen, setIsUploadOpen] = useState(false)
  const [viewingId, setViewingId] = useState<number | null>(null)

  const postsUrl = `${API_URL}/api/profile/${encodeURIComponent(username)}/posts`

  const loadFirstPage = useCallback(
    async (signal?: AbortSignal) => {
      setLoadState("loading")

      try {
        const response = await fetch(postsUrl, {
          credentials: "include",
          signal,
        })

        if (response.status === 401) {
          setLoadState("unauthenticated")
          return
        }

        if (response.status === 403) {
          setLoadState("forbidden")
          return
        }

        if (response.status === 404) {
          setLoadState("not-found")
          return
        }

        if (!response.ok) {
          setLoadState("error")
          return
        }

        const data = (await response.json()) as PostsPage

        setPosts(data.posts)
        setNextCursor(data.nextCursor)
        setLoadState("ready")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return
        }

        setLoadState("error")
      }
    },
    [postsUrl]
  )

  // Reloads when the username changes (a rename) or when the viewer becomes
  // allowed to see posts (they just became friends).
  useEffect(() => {
    if (!canView) return

    const controller = new AbortController()
    void loadFirstPage(controller.signal)

    return () => controller.abort()
  }, [canView, loadFirstPage])

  async function handleLoadMore() {
    if (nextCursor === null || isLoadingMore) return

    setIsLoadingMore(true)
    setMoreFailed(false)

    try {
      const response = await fetch(`${postsUrl}?before=${nextCursor}`, {
        credentials: "include",
      })

      if (!response.ok) {
        setMoreFailed(true)
        return
      }

      const data = (await response.json()) as PostsPage

      // A post created while paging could otherwise appear twice.
      setPosts((current) => {
        const seen = new Set(current.map((post) => post.id))

        return [...current, ...data.posts.filter((post) => !seen.has(post.id))]
      })
      setNextCursor(data.nextCursor)
    } catch {
      setMoreFailed(true)
    } finally {
      setIsLoadingMore(false)
    }
  }

  function handleCreated(post: Post) {
    setPosts((current) => [post, ...current])
    setLoadState("ready")
  }

  function handleDeleted(id: number) {
    setPosts((current) => current.filter((post) => post.id !== id))
    setViewingId(null)
  }

  const viewing = posts.find((post) => post.id === viewingId) ?? null

  function renderBody() {
    if (!canView || loadState === "forbidden") {
      return (
        <p className="text-muted-foreground">
          Posts are only visible to friends.
        </p>
      )
    }

    if (loadState === "loading") {
      return <PostsGridSkeleton />
    }

    if (loadState === "unauthenticated") {
      return (
        <p className="text-muted-foreground" role="alert">
          Your session has expired. Sign in again to see posts.
        </p>
      )
    }

    if (loadState === "not-found") {
      return (
        <p className="text-muted-foreground" role="alert">
          Posts aren’t available for this account.
        </p>
      )
    }

    if (loadState === "error") {
      return (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-muted-foreground">We couldn’t load posts.</p>
          <Button variant="outline" onClick={() => void loadFirstPage()}>
            Try again
          </Button>
        </div>
      )
    }

    if (posts.length === 0) {
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">
            {isOwner
              ? "You haven’t posted anything yet."
              : "No posts yet."}
          </p>
          {isOwner && (
            <Button onClick={() => setIsUploadOpen(true)}>
              <IconPlus />
              Create your first post
            </Button>
          )}
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-4">
        <ul className="grid grid-cols-3 gap-1.5">
          {posts.map((post) => {
            const label =
              post.caption ??
              (post.media.type === "video" ? "Video post" : "Photo post")

            return (
              <li key={post.id}>
                <button
                  type="button"
                  onClick={() => setViewingId(post.id)}
                  aria-label={`Open: ${label}`}
                  className="group relative block aspect-square w-full overflow-hidden rounded-md bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {post.media.thumbUrl ? (
                    <img
                      src={post.media.thumbUrl}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover transition-opacity group-hover:opacity-90"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-muted-foreground">
                      <IconPhoto className="size-8" />
                    </span>
                  )}

                  {post.media.type === "video" && (
                    <span className="absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-xs font-medium text-white">
                      <IconPlayerPlayFilled className="size-3" />
                      {formatDuration(post.media.durationSeconds)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        {nextCursor !== null && (
          <div className="flex flex-col items-center gap-2">
            <Button
              variant="outline"
              disabled={isLoadingMore}
              onClick={() => void handleLoadMore()}
            >
              {isLoadingMore ? "Loading…" : "Load more"}
            </Button>
            {moreFailed && (
              <p className="text-sm text-destructive" role="alert">
                Couldn’t load more posts. Try again.
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  const showNewPostButton =
    isOwner && canView && loadState === "ready" && posts.length > 0

  return (
    <section className="mt-8" aria-labelledby="posts-heading">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="posts-heading" className="text-xl font-semibold">
          Posts
        </h2>

        {showNewPostButton && (
          <Button size="sm" onClick={() => setIsUploadOpen(true)}>
            <IconPlus />
            New post
          </Button>
        )}
      </div>

      {renderBody()}

      {isUploadOpen && (
        <PostUploadDialog
          onClose={() => setIsUploadOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {viewing && (
        <PostViewer
          post={viewing}
          isOwner={isOwner}
          onClose={() => setViewingId(null)}
          onDeleted={handleDeleted}
        />
      )}
    </section>
  )
}

export default ProfilePosts