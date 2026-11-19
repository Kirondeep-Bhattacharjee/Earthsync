import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  IconArrowLeft,
  IconDotsVertical,
  IconSend,
  IconTrash,
} from "@tabler/icons-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { ChatThreadSkeleton } from "@/components/skeletons/chat-thread-skeleton"
import {
  useChatSocket,
  type ChatMessage,
  type ServerEvent,
} from "@/lib/chat-socket"
import { formatDayLabel, isSameDay } from "@/lib/format-time"
import { notifyUnreadChanged } from "@/lib/use-unread-count"
import { cn } from "@/lib/utils"

const API_URL = import.meta.env.VITE_API_URL ?? ""

const PAGE_SIZE = 30
const MAX_LENGTH = 2000
// A send with no ack after this long is shown as failed.
const SEND_TIMEOUT_MS = 15_000

/* ------------------------------------------------------------------ */
/* Types and helpers                                                   */
/* ------------------------------------------------------------------ */

// One bubble. Messages from the server have an id; a message that is still
// being sent has `id: null` until the ack arrives. `key` never changes, so a
// bubble does not remount when its id arrives.
type Item = {
  key: string
  id: number | null
  clientId: string | null
  body: string
  createdAt: string
  fromMe: boolean
  status: "sent" | "sending" | "failed"
  error: string | null
}

type LoadState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "not-found" }
  | { status: "error" }
  | { status: "ready"; items: Item[]; nextCursor: number | null }

type MessagesResponse = {
  messages: ChatMessage[]
  nextCursor: number | null
}

const NO_ITEMS: Item[] = []

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
})

function formatClock(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.getTime()) ? "" : clockFormat.format(date)
}

function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function fromServer(message: ChatMessage): Item {
  return {
    key: `m${message.id}`,
    id: message.id,
    clientId: null,
    body: message.body,
    createdAt: message.createdAt,
    fromMe: message.fromMe,
    status: "sent",
    error: null,
  }
}

// Messages with an id in id order, then the ones still being sent or failed.
function normalize(items: Item[]): Item[] {
  const confirmed = items
    .filter((item) => item.id !== null)
    .sort((a, b) => (a.id as number) - (b.id as number))
  const pending = items.filter((item) => item.id === null)

  return [...confirmed, ...pending]
}

// Adds messages from the server (a page of history or a live message). A
// message that is already listed is updated, never duplicated.
function mergePage(items: Item[], messages: ChatMessage[]): Item[] {
  const byId = new Map<number, Item>()

  for (const item of items) {
    if (item.id !== null) {
      byId.set(item.id, item)
    }
  }

  for (const message of messages) {
    const existing = byId.get(message.id)

    byId.set(
      message.id,
      existing
        ? {
            ...existing,
            body: message.body,
            createdAt: message.createdAt,
            status: "sent",
            error: null,
          }
        : fromServer(message)
    )
  }

  return normalize([
    ...byId.values(),
    ...items.filter((item) => item.id === null),
  ])
}

function applyAck(items: Item[], clientId: string, id: number): Item[] {
  return normalize(
    items
      .filter((item) => item.id !== id)
      .map((item) =>
        item.clientId === clientId
          ? { ...item, id, status: "sent" as const, error: null }
          : item
      )
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ChatThread() {
  const { username = "" } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const { status: socketStatus, reconnectCount, send, subscribe } =
    useChatSocket()

  const [state, setState] = React.useState<LoadState>({ status: "loading" })
  const [pictureUrl, setPictureUrl] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState("")
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [olderFailed, setOlderFailed] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  const abortRef = React.useRef<AbortController | null>(null)
  const nameRef = React.useRef(username)
  const timersRef = React.useRef(new Map<string, number>())

  const items = state.status === "ready" ? state.items : NO_ITEMS
  const nextCursor = state.status === "ready" ? state.nextCursor : null

  /* ---------------------------- loading ---------------------------- */

  // `quiet` refetches the newest page and merges it, without the skeleton, and
  // keeps what is on screen if it fails.
  const loadLatest = React.useCallback(
    async (options: { quiet?: boolean } = {}) => {
      abortRef.current?.abort()

      const controller = new AbortController()
      abortRef.current = controller

      if (!options.quiet) {
        setState({ status: "loading" })
      }

      try {
        const response = await fetch(
          `${API_URL}/api/conversations/${encodeURIComponent(username)}/messages?limit=${PAGE_SIZE}`,
          { credentials: "include", signal: controller.signal }
        )

        if (response.status === 401) {
          setState({ status: "unauthenticated" })
          return
        }

        if (response.status === 404) {
          setState({ status: "not-found" })
          return
        }

        if (!response.ok) {
          throw new Error(`Unexpected status ${response.status}`)
        }

        const data = (await response.json()) as MessagesResponse

        setState((previous) =>
          options.quiet && previous.status === "ready"
            ? {
                status: "ready",
                items: mergePage(previous.items, data.messages),
                nextCursor:
                  previous.items.length === 0
                    ? data.nextCursor
                    : previous.nextCursor,
              }
            : {
                status: "ready",
                items: mergePage([], data.messages),
                nextCursor: data.nextCursor,
              }
        )
      } catch {
        if (controller.signal.aborted || options.quiet) {
          return
        }

        setState({ status: "error" })
      }
    },
    [username]
  )

  const seenReconnectRef = React.useRef(reconnectCount)

  // Tells the server everything in this thread has been seen, then refreshes the
  // sidebar badge. Only while the tab is visible: a message that arrives in a
  // background tab stays unread until the person comes back.
  const markRead = React.useCallback(() => {
    if (!username || document.visibilityState !== "visible") {
      return
    }

    fetch(`${API_URL}/api/conversations/${encodeURIComponent(username)}/read`, {
      method: "POST",
      credentials: "include",
    })
      .then((response) => {
        if (response.ok) {
          notifyUnreadChanged()
        }
      })
      .catch(() => {})
  }, [username])

  // Opening the thread (and coming back to its tab) marks it read.
  const isReady = state.status === "ready"

  React.useEffect(() => {
    if (!isReady) {
      return
    }

    markRead()
    document.addEventListener("visibilitychange", markRead)

    return () => document.removeEventListener("visibilitychange", markRead)
  }, [isReady, markRead])

  React.useEffect(() => {
    nameRef.current = username
    setLoadingOlder(false)
    setOlderFailed(false)
    setDraft("")
    setPictureUrl(null)

    if (!username) {
      setState({ status: "not-found" })
      return
    }

    void loadLatest()

    // The header picture is best effort: the thread works without it.
    const profileController = new AbortController()

    fetch(`${API_URL}/api/profile/${encodeURIComponent(username)}`, {
      credentials: "include",
      signal: profileController.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { user?: { profilePictureUrl?: string | null } } | null) => {
        setPictureUrl(data?.user?.profilePictureUrl ?? null)
      })
      .catch(() => {})

    return () => {
      abortRef.current?.abort()
      profileController.abort()
    }
  }, [username, loadLatest])

  // The socket came back after a drop: fetch what was missed.
  React.useEffect(() => {
    if (reconnectCount !== seenReconnectRef.current) {
      seenReconnectRef.current = reconnectCount
      void loadLatest({ quiet: true })
      markRead()
    }
  }, [reconnectCount, loadLatest, markRead])

  // The scroller keeps the view in place when older messages are added on top.
  async function loadOlder() {
    if (state.status !== "ready" || state.nextCursor === null || loadingOlder) {
      return
    }

    const requestedFor = username

    setLoadingOlder(true)
    setOlderFailed(false)

    try {
      const response = await fetch(
        `${API_URL}/api/conversations/${encodeURIComponent(username)}/messages?limit=${PAGE_SIZE}&before=${state.nextCursor}`,
        { credentials: "include" }
      )

      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`)
      }

      const data = (await response.json()) as MessagesResponse

      if (nameRef.current !== requestedFor) {
        return
      }

      setState((previous) =>
        previous.status === "ready"
          ? {
              status: "ready",
              items: mergePage(previous.items, data.messages),
              nextCursor: data.nextCursor,
            }
          : previous
      )
    } catch {
      setOlderFailed(true)
    } finally {
      setLoadingOlder(false)
    }
  }

  /* ---------------------------- sending ---------------------------- */

  const patchItem = React.useCallback(
    (clientId: string, patch: Partial<Item>) => {
      setState((previous) =>
        previous.status === "ready"
          ? {
              ...previous,
              items: previous.items.map((item) =>
                item.clientId === clientId ? { ...item, ...patch } : item
              ),
            }
          : previous
      )
    },
    []
  )

  const clearTimer = React.useCallback((clientId: string) => {
    const timer = timersRef.current.get(clientId)

    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(clientId)
    }
  }, [])

  const sendBody = React.useCallback(
    (body: string) => {
      const clientId = newClientId()

      const item: Item = {
        key: clientId,
        id: null,
        clientId,
        body,
        createdAt: new Date().toISOString(),
        fromMe: true,
        status: "sending",
        error: null,
      }

      setState((previous) =>
        previous.status === "ready"
          ? { ...previous, items: [...previous.items, item] }
          : previous
      )

      if (!send(username, body, clientId)) {
        patchItem(clientId, {
          status: "failed",
          error: "Not connected. Check your connection and retry.",
        })
        return
      }

      timersRef.current.set(
        clientId,
        window.setTimeout(() => {
          timersRef.current.delete(clientId)
          patchItem(clientId, {
            status: "failed",
            error: "Not confirmed. Retrying may send it twice.",
          })
        }, SEND_TIMEOUT_MS)
      )
    },
    [username, send, patchItem]
  )

  function submit() {
    const body = draft.trim()

    if (!body || state.status !== "ready") {
      return
    }

    setDraft("")
    sendBody(body)
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line. Enter while an input method is
    // composing text (for example Japanese) must not send.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      submit()
    }
  }

  function retry(item: Item) {
    setState((previous) =>
      previous.status === "ready"
        ? {
            ...previous,
            items: previous.items.filter((other) => other.key !== item.key),
          }
        : previous
    )
    sendBody(item.body)
  }

  function discard(item: Item) {
    setState((previous) =>
      previous.status === "ready"
        ? {
            ...previous,
            items: previous.items.filter((other) => other.key !== item.key),
          }
        : previous
    )
  }

  // Live events: the ack gives a pending message its id, an error fails it, and
  // a message for this thread is added (or updated if it is already listed).
  React.useEffect(() => {
    return subscribe((event: ServerEvent) => {
      if (event.type === "ack" && event.clientId) {
        const clientId = event.clientId
        const id = event.id

        clearTimer(clientId)
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, items: applyAck(previous.items, clientId, id) }
            : previous
        )
        return
      }

      if (event.type === "error" && event.clientId) {
        const clientId = event.clientId

        clearTimer(clientId)
        patchItem(clientId, {
          status: "failed",
          error:
            event.status === 429
              ? "Too many messages. Wait a moment and retry."
              : event.message,
        })
        return
      }

      if (event.type === "message" && event.username === username) {
        const message = event.chatMessage

        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, items: mergePage(previous.items, [message]) }
            : previous
        )

        // The thread is open, so a message from them is seen right away.
        if (!message.fromMe) {
          markRead()
        }
      }
    })
  }, [subscribe, username, clearTimer, patchItem, markRead])

  React.useEffect(() => {
    const timers = timersRef.current

    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }

      timers.clear()
    }
  }, [])

  /* ---------------------------- delete ----------------------------- */

  async function deleteChat() {
    setDeleting(true)
    setDeleteError(null)

    try {
      const response = await fetch(
        `${API_URL}/api/conversations/${encodeURIComponent(username)}`,
        { method: "DELETE", credentials: "include" }
      )

      if (response.status === 401) {
        setDeleteOpen(false)
        setState({ status: "unauthenticated" })
        return
      }

      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`)
      }

      navigate("/chats")
    } catch {
      setDeleteError("Could not delete the chat. Try again.")
    } finally {
      setDeleting(false)
    }
  }

  /* ---------------------------- render ----------------------------- */

  if (state.status === "loading") {
    return <ChatThreadSkeleton />
  }

  if (state.status === "unauthenticated") {
    return (
      <div
        className="mx-auto flex w-full max-w-2xl flex-col items-start gap-3 text-sm"
        role="alert"
      >
        <p>Your session expired. Sign in again to see this chat.</p>
        <Link to="/sign-in" className={buttonVariants({ size: "sm" })}>
          Sign in
        </Link>
      </div>
    )
  }

  if (state.status === "not-found") {
    return (
      <div
        className="mx-auto flex w-full max-w-2xl flex-col items-start gap-3 text-sm"
        role="alert"
      >
        <p>This conversation is not available.</p>
        <Link
          to="/chats"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to chats
        </Link>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div
        className="mx-auto flex w-full max-w-2xl flex-col items-start gap-3 text-sm"
        role="alert"
      >
        <p>Could not load this chat. Check your connection and try again.</p>
        <Button size="sm" variant="outline" onClick={() => void loadLatest()}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    // data-fullbleed tells SyncLayout to drop its padding for this page, and
    // h-full fills the space under the layout header.
    <div
      data-fullbleed
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-2 border-b bg-card/80 px-2 py-2.5 backdrop-blur sm:px-4">
        <Link
          to="/chats"
          aria-label="Back to chats"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
        >
          <IconArrowLeft aria-hidden="true" />
        </Link>

        <Link
          to={`/u/${username}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar className="size-9">
            {pictureUrl && <AvatarImage src={pictureUrl} alt="" />}
            <AvatarFallback>{username.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate font-medium">@{username}</span>
        </Link>

        {/* The trigger renders its own button (no asChild or render, Base UI flavor). */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Chat options"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <IconDotsVertical aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <IconTrash aria-hidden="true" />
              Delete chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {socketStatus === "closed" && (
        <p
          role="status"
          className="shrink-0 border-b bg-muted px-3 py-1.5 text-center text-xs text-muted-foreground"
        >
          Reconnecting. Messages may fail to send.
        </p>
      )}

      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="px-3 py-4 sm:px-6">
              {nextCursor !== null && (
                <div className="flex justify-center pb-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full text-xs text-muted-foreground"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {loadingOlder
                      ? "Loading…"
                      : olderFailed
                        ? "Could not load. Try again"
                        : "Load older messages"}
                  </Button>
                </div>
              )}

              {items.length === 0 && (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  No messages yet. Say hello to @{username}.
                </p>
              )}

              {items.map((item, index) => {
                const showDay =
                  index === 0 ||
                  !isSameDay(items[index - 1].createdAt, item.createdAt)
                const align = item.fromMe ? "end" : "start"

                return (
                  <React.Fragment key={item.key}>
                    {showDay && (
                      <div className="my-3 flex justify-center">
                        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                          {formatDayLabel(item.createdAt)}
                        </span>
                      </div>
                    )}

                    <MessageScrollerItem
                      messageId={item.key}
                      scrollAnchor={item.fromMe}
                    >
                      <Message align={align}>
                        <MessageContent>
                          <Bubble
                            align={align}
                            variant={item.fromMe ? undefined : "muted"}
                            className={cn(
                              item.fromMe &&
                                "bg-primary text-primary-foreground",
                              item.status !== "sent" && "opacity-70"
                            )}
                          >
                            <BubbleContent className="whitespace-pre-wrap break-words">
                              {item.body}
                            </BubbleContent>
                          </Bubble>

                          <div
                            className={cn(
                              "mt-1 flex items-center gap-2 px-1 text-xs text-muted-foreground",
                              item.fromMe ? "justify-end" : "justify-start"
                            )}
                          >
                            {item.status === "sending" && <span>Sending…</span>}

                            {item.status === "failed" && (
                              <>
                                <span className="text-destructive">
                                  {item.error}
                                </span>
                                <button
                                  type="button"
                                  className="underline underline-offset-2 hover:text-foreground"
                                  onClick={() => retry(item)}
                                >
                                  Retry
                                </button>
                                <button
                                  type="button"
                                  className="underline underline-offset-2 hover:text-foreground"
                                  onClick={() => discard(item)}
                                >
                                  Discard
                                </button>
                              </>
                            )}

                            {item.status === "sent" && (
                              <time dateTime={item.createdAt}>
                                {formatClock(item.createdAt)}
                              </time>
                            )}
                          </div>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  </React.Fragment>
                )
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>

          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* shrink-0 keeps the composer in place; the bottom padding clears the
          iPhone home bar (needs viewport-fit=cover in index.html). */}
      <div className="shrink-0 border-t bg-card p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3">
        <div className="flex items-end gap-2 rounded-2xl border bg-background p-1.5 shadow-xs focus-within:ring-2 focus-within:ring-ring/50">
          {/* Plain textarea: the shadcn Textarea has its own min height, which
              pushed the text to the top. h-9 and py-2 match the 36px send
              button, so one line is centered and it grows upward from there.
              text-base on mobile: iPhone Safari zooms the page on focus when
              an input's text is under 16px. */}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={`Message @${username}`}
            aria-label="Message"
            rows={1}
            maxLength={MAX_LENGTH}
            className="max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-5 outline-none [field-sizing:content] placeholder:text-muted-foreground md:text-sm"
          />
          <Button
            size="icon"
            className="size-9 shrink-0 rounded-full"
            aria-label="Send message"
            disabled={draft.trim() === ""}
            onClick={submit}
          >
            <IconSend aria-hidden="true" />
          </Button>
        </div>
      </div>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) {
            setDeleteOpen(open)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the conversation with @{username} for you only. They
              keep their copy, and the chat comes back if either of you sends a
              new message, showing only new messages.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void deleteChat()}
            >
              {deleting ? "Deleting…" : "Delete chat"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}