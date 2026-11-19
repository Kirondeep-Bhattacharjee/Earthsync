import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  COMMENT_MAX_LENGTH,
  EngagementError,
  addComment,
  deleteComment,
  fetchComments,
  isAbortError,
  messageOf,
  type PostComment,
} from "@/lib/post-engagement"
import { formatRelativeTime } from "@/lib/format-time"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

type PostCommentsProps = {
  postId: number
  // +1 after posting, -n after deleting (n includes the replies that go with it).
  onCountChange: (delta: number) => void
  onNavigate?: () => void
}

type ListState = "loading" | "ready" | "error"

// A comment as rendered. Confirmed comments have `id`; a comment that is
// still being posted has `id: null` until the server responds. `key` never
// changes, so a row does not remount when its id arrives (same idea as the
// chat thread's pending bubbles).
type CommentItem = {
  key: string
  id: number | null
  parentId: number | null
  body: string
  createdAt: string
  replyCount: number
  author: { username: string; profilePictureUrl: string | null }
  isMine: boolean
  canDelete: boolean
  status: "sent" | "posting" | "failed"
  error: string | null
}

// Replies of one top-level comment. `loaded` is false until the first fetch, so
// a reply posted before the thread was opened is not mistaken for the whole list.
type Thread = {
  items: CommentItem[]
  nextCursor: number | null
  loaded: boolean
  open: boolean
  loading: boolean
  error: string | null
}

const EMPTY_THREAD: Thread = {
  items: [],
  nextCursor: null,
  loaded: false,
  open: false,
  loading: false,
  error: null,
}

const COMPOSER_ID = "post-comment-composer"

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
const MOD_KEY = isMac ? "⌘" : "Ctrl"

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fromServer(comment: PostComment): CommentItem {
  return {
    key: `c${comment.id}`,
    id: comment.id,
    parentId: comment.parentId,
    body: comment.body,
    createdAt: comment.createdAt,
    replyCount: comment.replyCount,
    author: comment.author,
    isMine: comment.isMine,
    canDelete: comment.canDelete,
    status: "sent",
    error: null,
  }
}

// Adds server comments without duplicating. Pending comments (id === null)
// are kept as-is; server comments are deduped by id.
function mergeUnique(existing: CommentItem[], incoming: CommentItem[]) {
  const byId = new Map<number, CommentItem>()
  for (const item of existing) {
    if (item.id !== null) {
      byId.set(item.id, item)
    }
  }
  const keys = new Set(existing.map((item) => item.key))
  const out = [...existing]

  for (const item of incoming) {
    if (item.id !== null) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item)
        out.push(item)
      }
    } else if (!keys.has(item.key)) {
      keys.add(item.key)
      out.push(item)
    }
  }

  return out
}

// Re-renders every ~30s so "just now" becomes "1m", "1m" becomes "2m", etc.,
// without re-reading the server.
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/* ------------------------------------------------------------------ */
/* One comment row                                                     */
/* ------------------------------------------------------------------ */

type CommentRowProps = {
  comment: CommentItem
  now: Date
  confirming: boolean
  deleting: boolean
  deleteError: string | null
  onReply: () => void
  onRetry: () => void
  onDiscard: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  onNavigate?: () => void
}

function CommentRow({
  comment,
  now,
  confirming,
  deleting,
  deleteError,
  onReply,
  onRetry,
  onDiscard,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onNavigate,
}: CommentRowProps) {
  const { username, profilePictureUrl } = comment.author

  return (
    <div className={cn("flex gap-2", comment.status !== "sent" && "opacity-70")}>
      <Avatar className="size-8 shrink-0">
        <AvatarImage src={profilePictureUrl ?? undefined} alt="" />
        <AvatarFallback>{username.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words whitespace-pre-wrap">
          <Link
            to={`/u/${username}`}
            onClick={onNavigate}
            className="font-medium hover:underline"
          >
            @{username}
          </Link>{" "}
          {comment.body}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {comment.status === "sent" && (
            <time dateTime={comment.createdAt}>
              {formatRelativeTime(comment.createdAt, now)}
            </time>
          )}
          {comment.status === "posting" && <span>Posting…</span>}

          {comment.status === "sent" && (
            <button
              type="button"
              className="hover:text-foreground"
              onClick={onReply}
            >
              Reply
            </button>
          )}

          {comment.status === "sent" && comment.canDelete ? (
            confirming ? (
              <span className="flex items-center gap-2">
                <span>Delete this comment?</span>
                <button
                  type="button"
                  className="font-medium text-destructive hover:underline disabled:opacity-50"
                  onClick={onConfirmDelete}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={onCancelDelete}
                  disabled={deleting}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={onAskDelete}
              >
                Delete
              </button>
            )
          ) : null}

          {comment.status === "failed" && (
            <span className="flex items-center gap-2">
              <span className="text-destructive">{comment.error}</span>
              <button
                type="button"
                className="font-medium hover:text-foreground"
                onClick={onRetry}
              >
                Retry
              </button>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={onDiscard}
              >
                Discard
              </button>
            </span>
          )}
        </div>
        {deleteError ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {deleteError}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Comments section                                                    */
/* ------------------------------------------------------------------ */

// Render with key={postId} so switching posts resets all state.
export default function PostComments({
  postId,
  onCountChange,
  onNavigate,
}: PostCommentsProps) {
  const { user } = useAuth()
  const now = useNow()

  const [listState, setListState] = useState<ListState>("loading")
  const [listError, setListError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [items, setItems] = useState<CommentItem[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  const [threads, setThreads] = useState<Record<number, Thread>>({})

  const [draft, setDraft] = useState("")
  const [posting, setPosting] = useState(false)
  // rootId is always a top-level comment id: replies to replies join the same thread.
  const [replyTarget, setReplyTarget] = useState<{
    rootId: number
    username: string
  } | null>(null)

  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<{
    id: number
    message: string
  } | null>(null)

  // A synchronous guard so a fast double-click can't kick off two sends; the
  // `posting` state is for the UI only and lags by a render.
  const sendingRef = useRef(false)
  const pendingSeq = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setListState("loading")

    void (async () => {
      try {
        const page = await fetchComments(postId, {}, controller.signal)
        setItems(page.comments.map(fromServer))
        setNextCursor(page.nextCursor)
        setListState("ready")
      } catch (error) {
        if (isAbortError(error)) {
          return
        }
        setListError(messageOf(error))
        setListState("error")
      }
    })()

    return () => controller.abort()
  }, [postId, attempt])

  useEffect(() => {
    if (replyTarget) {
      document.getElementById(COMPOSER_ID)?.focus()
    }
  }, [replyTarget])

  /* ---------------------------- loading ---------------------------- */

  async function loadMore() {
    if (nextCursor === null || loadingMore) {
      return
    }

    setLoadingMore(true)
    setMoreError(null)

    try {
      const page = await fetchComments(postId, { before: nextCursor })
      setItems((current) => mergeUnique(current, page.comments.map(fromServer)))
      setNextCursor(page.nextCursor)
    } catch (error) {
      setMoreError(messageOf(error))
    } finally {
      setLoadingMore(false)
    }
  }

  function patchThread(rootId: number, patch: Partial<Thread>) {
    setThreads((current) => ({
      ...current,
      [rootId]: { ...(current[rootId] ?? EMPTY_THREAD), ...patch },
    }))
  }

  async function loadReplies(rootId: number, more: boolean) {
    const thread = threads[rootId] ?? EMPTY_THREAD
    if (thread.loading) {
      return
    }

    patchThread(rootId, { open: true, loading: true, error: null })

    try {
      const page = await fetchComments(postId, {
        parent: rootId,
        after: more && thread.nextCursor !== null ? thread.nextCursor : undefined,
      })

      setThreads((current) => {
        const existing = current[rootId] ?? EMPTY_THREAD
        return {
          ...current,
          [rootId]: {
            ...existing,
            items: mergeUnique(existing.items, page.comments.map(fromServer)),
            nextCursor: page.nextCursor,
            loaded: true,
            open: true,
            loading: false,
            error: null,
          },
        }
      })
    } catch (error) {
      patchThread(rootId, { loading: false, error: messageOf(error) })
    }
  }

  function openReplies(rootId: number) {
    const thread = threads[rootId]
    if (thread?.loaded) {
      patchThread(rootId, { open: true })
      return
    }
    void loadReplies(rootId, false)
  }

  /* ----------------------------- posting --------------------------- */

  function startReply(rootId: number, username: string, isReply: boolean) {
    setReplyTarget({ rootId, username })
    // Replying to a reply: mention who it is for, since the thread is flat.
    if (isReply && draft.trim() === "") {
      setDraft(`@${username} `)
    }
  }

  // Insert the optimistic comment into the right place, and bump the parent's
  // reply count and the total count. `key` is stable and never changes, so the
  // row does not remount when the server's id arrives.
  function insertOptimistic(item: CommentItem, rootId: number | null) {
    if (rootId === null) {
      setItems((current) => [item, ...current])
    } else {
      setThreads((current) => {
        const existing = current[rootId] ?? EMPTY_THREAD
        return {
          ...current,
          [rootId]: { ...existing, open: true, items: [...existing.items, item] },
        }
      })
      setItems((current) =>
        current.map((i) => (i.id === rootId ? { ...i, replyCount: i.replyCount + 1 } : i))
      )
    }
    onCountChange(1)
  }

  function patchByKey(key: string, rootId: number | null, patch: Partial<CommentItem>) {
    if (rootId === null) {
      setItems((current) => current.map((i) => (i.key === key ? { ...i, ...patch } : i)))
    } else {
      setThreads((current) => {
        const existing = current[rootId]
        if (!existing) {
          return current
        }
        return {
          ...current,
          [rootId]: {
            ...existing,
            items: existing.items.map((i) => (i.key === key ? { ...i, ...patch } : i)),
          },
        }
      })
    }
  }

  function removeByKey(key: string, rootId: number | null) {
    if (rootId === null) {
      setItems((current) => current.filter((i) => i.key !== key))
    } else {
      setThreads((current) => {
        const existing = current[rootId]
        if (!existing) {
          return current
        }
        return {
          ...current,
          [rootId]: {
            ...existing,
            items: existing.items.filter((i) => i.key !== key),
          },
        }
      })
    }
  }

  // `existingKey` is null for a fresh send; passing a key reuses that slot
  // (a retry) instead of adding a new optimistic row. Counts are only bumped
  // for a fresh send, not a retry, since the failed row already counted.
  async function runSend(body: string, rootId: number | null, existingKey: string | null) {
    const key = existingKey ?? `pending-${pendingSeq.current++}`

    if (existingKey === null) {
      const optimistic: CommentItem = {
        key,
        id: null,
        parentId: rootId,
        body,
        createdAt: new Date().toISOString(),
        replyCount: 0,
        author: { username: user?.username ?? "", profilePictureUrl: null },
        isMine: true,
        canDelete: false,
        status: "posting",
        error: null,
      }
      insertOptimistic(optimistic, rootId)
    } else {
      patchByKey(key, rootId, { status: "posting", error: null })
    }

    try {
      const { comment } = await addComment(postId, body, rootId)
      const real = fromServer(comment)
      // Patch every field the server returned except `key`, so the row keeps
      // its identity (no remount) and now shows the confirmed id and author.
      const { key: _realKey, ...patch } = real
      void _realKey
      patchByKey(key, rootId, patch)
    } catch (error) {
      patchByKey(key, rootId, { status: "failed", error: messageOf(error) })
    } finally {
      sendingRef.current = false
      setPosting(false)
    }
  }

  function beginSend(body: string, rootId: number | null) {
    if (sendingRef.current) {
      return
    }
    sendingRef.current = true
    setPosting(true)
    void runSend(body, rootId, null)
  }

  function submit() {
    const body = draft.trim()
    if (body === "") {
      return
    }
    const rootId = replyTarget?.rootId ?? null

    setDraft("")
    setReplyTarget(null)
    beginSend(body, rootId)
  }

  function retry(item: CommentItem) {
    if (sendingRef.current) {
      return
    }
    sendingRef.current = true
    setPosting(true)
    void runSend(item.body, item.parentId, item.key)
  }

  function discard(item: CommentItem) {
    removeByKey(item.key, item.parentId)
    if (item.parentId !== null) {
      setItems((current) =>
        current.map((i) =>
          i.id === item.parentId ? { ...i, replyCount: Math.max(0, i.replyCount - 1) } : i
        )
      )
    }
    onCountChange(-1)
  }

  /* ----------------------------- deleting -------------------------- */

  async function remove(comment: CommentItem) {
    if (comment.id === null) {
      return
    }

    setDeletingId(comment.id)
    setDeleteError(null)

    let removed = 1

    try {
      const result = await deleteComment(comment.id)
      removed = result.removed
    } catch (error) {
      // 404 means it is already gone (deleted elsewhere): drop it from the list too.
      if (!(error instanceof EngagementError && error.status === 404)) {
        setDeleteError({ id: comment.id, message: messageOf(error) })
        setDeletingId(null)
        return
      }
    }

    if (comment.parentId === null) {
      setItems((current) => current.filter((item) => item.id !== comment.id))
      setThreads((current) => {
        const next = { ...current }
        delete next[comment.id as number]
        return next
      })
    } else {
      const rootId = comment.parentId

      setThreads((current) => {
        const thread = current[rootId]
        if (!thread) {
          return current
        }
        return {
          ...current,
          [rootId]: {
            ...thread,
            items: thread.items.filter((item) => item.id !== comment.id),
          },
        }
      })
      setItems((current) =>
        current.map((item) =>
          item.id === rootId ? { ...item, replyCount: Math.max(0, item.replyCount - 1) } : item
        )
      )
    }

    if (replyTarget && replyTarget.rootId === comment.id) {
      setReplyTarget(null)
    }

    onCountChange(-removed)
    setConfirmId(null)
    setDeletingId(null)
  }

  function rowProps(comment: CommentItem, isReply: boolean, rootId: number) {
    return {
      comment,
      now,
      confirming: comment.id !== null && confirmId === comment.id,
      deleting: comment.id !== null && deletingId === comment.id,
      deleteError:
        comment.id !== null && deleteError?.id === comment.id ? deleteError.message : null,
      onReply: () => startReply(rootId, comment.author.username, isReply),
      onRetry: () => retry(comment),
      onDiscard: () => discard(comment),
      onAskDelete: () => {
        setConfirmId(comment.id)
        setDeleteError(null)
      },
      onCancelDelete: () => setConfirmId(null),
      onConfirmDelete: () => void remove(comment),
      onNavigate,
    }
  }

  /* ------------------------------ view ----------------------------- */

  return (
    <section aria-label="Comments" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {replyTarget ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Replying to @{replyTarget.username}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setReplyTarget(null)}
            >
              Cancel reply
            </Button>
          </div>
        ) : null}
        <Textarea
          id={COMPOSER_ID}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              submit()
            }
          }}
          maxLength={COMMENT_MAX_LENGTH}
          rows={2}
          disabled={posting}
          placeholder={
            replyTarget ? `Reply to @${replyTarget.username}` : "Add a comment"
          }
          aria-label={replyTarget ? "Write a reply" : "Write a comment"}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {draft.length}/{COMMENT_MAX_LENGTH}
          </span>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              <kbd className="rounded border bg-muted px-1 font-sans text-[10px]">{MOD_KEY}</kbd>
              {" + "}
              <kbd className="rounded border bg-muted px-1 font-sans text-[10px]">Enter</kbd>{" "}
              to post
            </span>
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={posting || draft.trim().length === 0}
            >
              {posting ? "Posting…" : replyTarget ? "Post reply" : "Post comment"}
            </Button>
          </div>
        </div>
      </div>

      {listState === "loading" ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading comments</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex gap-2">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-10 flex-1" />
            </div>
          ))}
        </div>
      ) : null}

      {listState === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {listError ?? "Could not load comments."}
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
      ) : null}

      {listState === "ready" && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No comments yet. Start the conversation.
        </p>
      ) : null}

      {listState === "ready" && items.length > 0 ? (
        // No inner scroll cap: the post dialog is the single scroll container,
        // so a long thread scrolls the dialog instead of nesting two scrollers.
        <ul className="flex flex-col gap-4">
          {items.map((comment) => {
            const thread = comment.id !== null ? threads[comment.id] : undefined

            return (
              <li key={comment.key} className="flex flex-col gap-2">
                <CommentRow {...rowProps(comment, false, comment.id as number)} />

                {comment.replyCount > 0 && !thread?.open ? (
                  <button
                    type="button"
                    className="ml-10 self-start text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => comment.id !== null && openReplies(comment.id)}
                  >
                    View {comment.replyCount}{" "}
                    {comment.replyCount === 1 ? "reply" : "replies"}
                  </button>
                ) : null}

                {thread?.open ? (
                  <ul className="ml-10 flex flex-col gap-3">
                    {thread.items.map((reply) => (
                      <li key={reply.key}>
                        <CommentRow {...rowProps(reply, true, comment.id as number)} />
                      </li>
                    ))}
                    {thread.loading ? (
                      <li role="status">
                        <span className="sr-only">Loading replies</span>
                        <Skeleton className="h-8 w-full" />
                      </li>
                    ) : null}
                    {thread.error ? (
                      <li>
                        <p role="alert" className="text-xs text-destructive">
                          {thread.error}
                        </p>
                      </li>
                    ) : null}
                    <li className="flex gap-3 text-xs text-muted-foreground">
                      {thread.nextCursor !== null && !thread.loading ? (
                        <button
                          type="button"
                          className="hover:text-foreground"
                          onClick={() => comment.id !== null && void loadReplies(comment.id, true)}
                        >
                          Show more replies
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="hover:text-foreground"
                        onClick={() => comment.id !== null && patchThread(comment.id, { open: false })}
                      >
                        Hide replies
                      </button>
                    </li>
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {listState === "ready" && nextCursor !== null ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more comments"}
          </Button>
          {moreError ? (
            <p role="alert" className="text-xs text-destructive">
              {moreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
