import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  IconArrowLeft,
  IconCheck,
  IconChecks,
  IconDotsVertical,
  IconMicrophone,
  IconPhoto,
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
  IMAGE_MAX_BYTES,
  UploadError,
  prepareImage,
  uploadAttachment,
  type AttachmentKind,
} from "@/lib/chat-attachment"
import {
  useChatSocket,
  type ChatMedia,
  type ChatMessage,
  type ReceiptStatus,
  type ServerEvent,
} from "@/lib/chat-socket"
import { formatDayLabel, isSameDay } from "@/lib/format-time"
import { notifyUnreadChanged } from "@/lib/use-unread-count"
import {
  VOICE_MAX_SECONDS,
  useVoiceRecorder,
  type RecordedVoice,
} from "@/lib/use-voice-recorder"
import { cn } from "@/lib/utils"

const API_URL = import.meta.env.VITE_API_URL ?? ""

const PAGE_SIZE = 30
const MAX_LENGTH = 2000
// A send with no ack after this long is shown as failed.
const SEND_TIMEOUT_MS = 15_000
// Signed media URLs last 30 to 45 minutes. Refetch well before that.
const MEDIA_REFRESH_MS = 20 * 60_000
// A broken image or audio element triggers a refetch, at most this often.
const MEDIA_ERROR_REFRESH_GAP_MS = 30_000

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
  kind: ChatMessage["kind"]
  body: string | null
  // Signed URLs from the server. Null while a photo or voice note is uploading.
  media: ChatMedia | null
  // A photo still uploading is shown from the file on this device.
  localUrl: string | null
  // 0 to 1 while an attachment uploads, otherwise null.
  progress: number | null
  // What to send again if the upload failed.
  upload: { kind: AttachmentKind; file: Blob; fileName: string } | null
  createdAt: string
  fromMe: boolean
  status: "sent" | "sending" | "failed"
  // Delivery state of my own message (sent, delivered, read). Separate from
  // `status`, which is only about the send itself.
  receipt: ReceiptStatus | null
  error: string | null
}

type LoadState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "not-found" }
  | { status: "error" }
  | {
      status: "ready"
      items: Item[]
      nextCursor: number | null
      // Photos and voice notes can only be sent to friends.
      isFriend: boolean
    }

type MessagesResponse = {
  messages: ChatMessage[]
  nextCursor: number | null
  isFriend: boolean
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

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

const RECEIPT_RANK: Record<ReceiptStatus, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
}

// A message only ever moves forward: sent, delivered, read.
function maxReceipt(
  a: ReceiptStatus | null,
  b: ReceiptStatus | null
): ReceiptStatus | null {
  if (a === null) return b
  if (b === null) return a

  return RECEIPT_RANK[a] >= RECEIPT_RANK[b] ? a : b
}

// Highest message ids the other person has received / read. A live receipt can
// arrive before the message it covers is in the list (a REST send), so these are
// kept separately and applied when drawing, instead of patching items.
type Floors = { delivered: number; read: number }

function receiptFor(item: Item, floors: Floors): ReceiptStatus {
  let status: ReceiptStatus = item.receipt ?? "sent"

  if (item.id !== null) {
    if (item.id <= floors.read) {
      status = maxReceipt(status, "read") as ReceiptStatus
    } else if (item.id <= floors.delivered) {
      status = maxReceipt(status, "delivered") as ReceiptStatus
    }
  }

  return status
}

function fromServer(message: ChatMessage): Item {
  return {
    key: `m${message.id}`,
    id: message.id,
    clientId: null,
    kind: message.kind,
    body: message.body,
    media: message.media,
    localUrl: null,
    progress: null,
    upload: null,
    createdAt: message.createdAt,
    fromMe: message.fromMe,
    status: "sent",
    receipt: message.status,
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
            kind: message.kind,
            body: message.body,
            // A refetch brings fresh signed URLs, so the media is replaced too.
            media: message.media,
            createdAt: message.createdAt,
            status: "sent",
            receipt: maxReceipt(existing.receipt, message.status),
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
          ? {
              ...item,
              id,
              status: "sent" as const,
              receipt: item.receipt ?? ("sent" as const),
              error: null,
            }
          : item
      )
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Photo and voice bubbles                                             */
/* ------------------------------------------------------------------ */

// One tick = sent, two = delivered, two in color = read. The blue is the one
// color that is not a theme token: it has to stand out from the muted ticks in
// both light and dark mode. Swap it if you prefer another.
function ReceiptTicks({ status }: { status: ReceiptStatus }) {
  const label =
    status === "read" ? "Read" : status === "delivered" ? "Delivered" : "Sent"
  const Icon = status === "sent" ? IconCheck : IconChecks

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-flex items-center", status === "read" && "text-sky-500")}
    >
      <Icon className="size-4" aria-hidden="true" />
    </span>
  )
}

// The inside of a photo or voice bubble. While an upload is under way there is
// no server media yet, so a photo is shown from the file on this device.
// `onMediaError` fires when a signed URL has expired (see refreshMedia).
function AttachmentView({
  item,
  onMediaError,
}: {
  item: Item
  onMediaError: () => void
}) {
  const uploading = item.id === null && item.status === "sending"
  const percent = Math.round((item.progress ?? 0) * 100)

  if (item.kind === "image") {
    const media = item.media
    const src = media?.thumbUrl ?? media?.url ?? item.localUrl
    // The size is known up front, so the thread does not jump when it loads.
    const ratio =
      media?.width && media.height ? `${media.width} / ${media.height}` : undefined

    const picture = (
      <div className="relative">
        {src ? (
          <img
            src={src}
            alt="Photo"
            loading="lazy"
            onError={onMediaError}
            style={ratio ? { aspectRatio: ratio } : undefined}
            className="block max-h-72 w-64 max-w-full rounded-md bg-muted object-cover"
          />
        ) : (
          <div className="h-40 w-52 rounded-md bg-muted" />
        )}

        {uploading && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60 text-xs font-medium text-foreground"
          >
            {percent}%
          </div>
        )}
      </div>
    )

    return media ? (
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open photo"
        className="block"
      >
        {picture}
      </a>
    ) : (
      picture
    )
  }

  if (item.media) {
    return (
      <audio
        controls
        preload="metadata"
        src={item.media.url}
        onError={onMediaError}
        aria-label={
          item.media.durationSeconds
            ? `Voice message, ${formatDuration(item.media.durationSeconds)}`
            : "Voice message"
        }
        className="h-10 w-60 max-w-full"
      />
    )
  }

  return (
    <div
      role={uploading ? "status" : undefined}
      className="flex h-10 w-60 max-w-full items-center gap-2 px-2 text-xs"
    >
      <IconMicrophone className="size-4 shrink-0" aria-hidden="true" />
      <span>{uploading ? `Sending voice message… ${percent}%` : "Voice message"}</span>
    </div>
  )
}

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

  const [composerError, setComposerError] = React.useState<string | null>(null)
  const [floors, setFloors] = React.useState<Floors>({ delivered: 0, read: 0 })

  const abortRef = React.useRef<AbortController | null>(null)
  const nameRef = React.useRef(username)
  const timersRef = React.useRef(new Map<string, number>())
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  // Object URLs for photos being uploaded; all are released when the page closes.
  const objectUrlsRef = React.useRef(new Set<string>())
  const fetchedAtRef = React.useRef(0)
  const mediaErrorAtRef = React.useRef(0)

  const items = state.status === "ready" ? state.items : NO_ITEMS
  const nextCursor = state.status === "ready" ? state.nextCursor : null
  const isFriend = state.status === "ready" ? state.isFriend : false

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

        fetchedAtRef.current = Date.now()

        setState((previous) =>
          options.quiet && previous.status === "ready"
            ? {
                status: "ready",
                items: mergePage(previous.items, data.messages),
                nextCursor:
                  previous.items.length === 0
                    ? data.nextCursor
                    : previous.nextCursor,
                isFriend: data.isFriend,
              }
            : {
                status: "ready",
                items: mergePage([], data.messages),
                nextCursor: data.nextCursor,
                isFriend: data.isFriend,
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
    setComposerError(null)
    setFloors({ delivered: 0, read: 0 })

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

  // Signed media URLs expire. Refetch the newest page (which brings fresh URLs)
  // every 20 minutes while the tab is visible, and when the tab comes back after
  // a long time away. Only the newest page is refreshed: a photo far up in older
  // history that was loaded long ago may need "Load older messages" again.
  React.useEffect(() => {
    if (!isReady) {
      return
    }

    function refreshIfStale() {
      if (
        document.visibilityState === "visible" &&
        Date.now() - fetchedAtRef.current >= MEDIA_REFRESH_MS
      ) {
        void loadLatest({ quiet: true })
      }
    }

    const interval = window.setInterval(refreshIfStale, 60_000)

    document.addEventListener("visibilitychange", refreshIfStale)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", refreshIfStale)
    }
  }, [isReady, loadLatest])

  // An image or audio element that fails to load most likely has an expired URL.
  const refreshMedia = React.useCallback(() => {
    if (Date.now() - mediaErrorAtRef.current < MEDIA_ERROR_REFRESH_GAP_MS) {
      return
    }

    mediaErrorAtRef.current = Date.now()
    void loadLatest({ quiet: true })
  }, [loadLatest])

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
              isFriend: previous.isFriend,
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
        kind: "text",
        body,
        media: null,
        localUrl: null,
        progress: null,
        upload: null,
        createdAt: new Date().toISOString(),
        fromMe: true,
        status: "sending",
        receipt: null,
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

  function removeItem(item: Item) {
    if (item.localUrl) {
      URL.revokeObjectURL(item.localUrl)
      objectUrlsRef.current.delete(item.localUrl)
    }

    setState((previous) =>
      previous.status === "ready"
        ? {
            ...previous,
            items: previous.items.filter((other) => other.key !== item.key),
          }
        : previous
    )
  }

  function retry(item: Item) {
    removeItem(item)

    if (item.upload) {
      void sendAttachment(item.upload.kind, item.upload.file, item.upload.fileName)
    } else if (item.body !== null) {
      sendBody(item.body)
    }
  }

  function discard(item: Item) {
    removeItem(item)
  }

  /* -------------------------- attachments -------------------------- */

  // Photos and voice notes go over REST (a socket frame is far too small). The
  // bubble appears at once with a progress bar; when the server answers, the
  // pending bubble is replaced by the saved message. The socket also pushes the
  // same message, and mergePage dedupes by id, so it never shows twice.
  const sendAttachment = React.useCallback(
    async (kind: AttachmentKind, file: Blob, fileName: string) => {
      const requestedFor = username
      const clientId = newClientId()
      const localUrl = kind === "image" ? URL.createObjectURL(file) : null

      if (localUrl) {
        objectUrlsRef.current.add(localUrl)
      }

      const pending: Item = {
        key: clientId,
        id: null,
        clientId,
        kind: kind === "image" ? "image" : "voice",
        body: null,
        media: null,
        localUrl,
        progress: 0,
        upload: { kind, file, fileName },
        createdAt: new Date().toISOString(),
        fromMe: true,
        status: "sending",
        receipt: null,
        error: null,
      }

      setComposerError(null)
      setState((previous) =>
        previous.status === "ready"
          ? { ...previous, items: [...previous.items, pending] }
          : previous
      )

      // A failed upload keeps its preview so Retry can show it again.
      let keepPreview = false

      try {
        const message = await uploadAttachment({
          username: requestedFor,
          kind,
          file,
          fileName,
          onProgress: (fraction) => patchItem(clientId, { progress: fraction }),
        })

        // They moved to another thread meanwhile. The message is saved and will
        // show when this thread is opened again.
        if (nameRef.current !== requestedFor) {
          return
        }

        setState((previous) =>
          previous.status === "ready"
            ? {
                ...previous,
                items: mergePage(
                  previous.items.filter((item) => item.clientId !== clientId),
                  [message]
                ),
              }
            : previous
        )
      } catch (error) {
        const status = error instanceof UploadError ? error.status : 0

        if (status === 401) {
          setState({ status: "unauthenticated" })
          return
        }

        // A failure that belongs to a thread they already left changes nothing
        // on screen (the pending bubble went with that thread's state).
        if (nameRef.current !== requestedFor) {
          return
        }

        keepPreview = true

        patchItem(clientId, {
          status: "failed",
          progress: null,
          error:
            error instanceof UploadError
              ? error.message
              : "Could not send. Try again.",
        })

        // Not friends any more: stop offering photos and voice notes.
        if (status === 403) {
          setState((previous) =>
            previous.status === "ready"
              ? { ...previous, isFriend: false }
              : previous
          )
        }
      } finally {
        if (localUrl && !keepPreview) {
          URL.revokeObjectURL(localUrl)
          objectUrlsRef.current.delete(localUrl)
        }
      }
    },
    [username, patchItem]
  )

  async function onPickImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    // Reset so picking the same photo twice in a row still fires onChange.
    event.target.value = ""

    if (!file || state.status !== "ready") {
      return
    }

    if (!file.type.startsWith("image/")) {
      setComposerError("Choose a photo to send.")
      return
    }

    const prepared = await prepareImage(file)

    if (prepared.size > IMAGE_MAX_BYTES) {
      setComposerError("That photo is too large. Photos can be up to 5 MB.")
      return
    }

    const name = prepared.type === "image/webp" ? "photo.webp" : file.name

    void sendAttachment("image", prepared, name)
  }

  const onVoiceFinished = React.useCallback(
    (voice: RecordedVoice) => {
      void sendAttachment("voice", voice.blob, voice.fileName)
    },
    [sendAttachment]
  )

  const recorder = useVoiceRecorder(onVoiceFinished)
  const cancelRecording = recorder.cancel

  // Switching to another chat drops a recording in progress.
  React.useEffect(() => {
    return () => cancelRecording()
  }, [username, cancelRecording])

  // Leaving the page releases the photo previews. An upload already under way
  // is left to finish, so a photo is not lost because they went back to the list.
  React.useEffect(() => {
    const urls = objectUrlsRef.current

    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url)
      }

      urls.clear()
    }
  }, [])

  // Live events: the ack gives a pending message its id, an error fails it, and
  // a message for this thread is added (or updated if it is already listed).
  React.useEffect(() => {
    return subscribe((event: ServerEvent) => {
      if (event.type === "receipt") {
        if (event.username === username) {
          setFloors((previous) => ({
            delivered:
              event.status === "delivered"
                ? Math.max(previous.delivered, event.upToId)
                : previous.delivered,
            read:
              event.status === "read"
                ? Math.max(previous.read, event.upToId)
                : previous.read,
          }))
        }

        return
      }

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
                            {item.kind === "text" ? (
                              <BubbleContent className="whitespace-pre-wrap break-words">
                                {item.body}
                              </BubbleContent>
                            ) : (
                              <BubbleContent className="p-1">
                                <AttachmentView
                                  item={item}
                                  onMediaError={refreshMedia}
                                />
                              </BubbleContent>
                            )}
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
                              <>
                                <time dateTime={item.createdAt}>
                                  {formatClock(item.createdAt)}
                                </time>
                                {item.fromMe && (
                                  <ReceiptTicks status={receiptFor(item, floors)} />
                                )}
                              </>
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
        {(composerError ?? recorder.error) && (
          <p role="alert" className="mb-2 px-2 text-xs text-destructive">
            {composerError ?? recorder.error}
          </p>
        )}

        {/* Photos and voice notes are friends only (the server enforces it
            too); the buttons are not shown to anyone else. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void onPickImage(event)}
        />

        {recorder.state === "recording" ? (
          <div className="flex items-center gap-2 rounded-2xl border bg-background p-1.5 shadow-xs">
            <Button
              size="icon"
              variant="ghost"
              className="size-9 shrink-0 rounded-full"
              aria-label="Cancel recording"
              onClick={recorder.cancel}
            >
              <IconTrash aria-hidden="true" />
            </Button>

            <div
              role="status"
              className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm"
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive"
              />
              <span className="tabular-nums">
                {formatDuration(recorder.elapsed)} /{" "}
                {formatDuration(VOICE_MAX_SECONDS)}
              </span>
            </div>

            <Button
              size="icon"
              className="size-9 shrink-0 rounded-full"
              aria-label="Send voice message"
              onClick={recorder.stop}
            >
              <IconSend aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <div className="flex items-end gap-2 rounded-2xl border bg-background p-1.5 shadow-xs focus-within:ring-2 focus-within:ring-ring/50">
            {isFriend && (
              <Button
                size="icon"
                variant="ghost"
                className="size-9 shrink-0 rounded-full"
                aria-label="Send a photo"
                onClick={() => {
                  setComposerError(null)
                  fileInputRef.current?.click()
                }}
              >
                <IconPhoto aria-hidden="true" />
              </Button>
            )}

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

            {/* With nothing typed, a friend gets the microphone; as soon as
                there is text, it turns into Send. */}
            {isFriend && recorder.supported && draft.trim() === "" ? (
              <Button
                size="icon"
                variant="ghost"
                className="size-9 shrink-0 rounded-full"
                aria-label="Record a voice message"
                disabled={recorder.state === "starting"}
                onClick={() => {
                  setComposerError(null)
                  void recorder.start()
                }}
              >
                <IconMicrophone aria-hidden="true" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-9 shrink-0 rounded-full"
                aria-label="Send message"
                disabled={draft.trim() === ""}
                onClick={submit}
              >
                <IconSend aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
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