import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  IconAlertCircle,
  IconArrowBackUp,
  IconArrowLeft,
  IconBan,
  IconCheck,
  IconChecks,
  IconDotsVertical,
  IconLock,
  IconMessage,
  IconMessageOff,
  IconMicrophone,
  IconPhoto,
  IconClock,
  IconInfoCircle,
  IconPin,
  IconPinnedOff,
  IconSend,
  IconStar,
  IconStarOff,
  IconTrash,
  IconX,
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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { ChatThreadSkeleton } from "@/components/skeletons/chat-thread-skeleton"
import { MediaViewer } from "@/components/chat/media-viewer"
import { ChatInfoSheet } from "@/components/chat/chat-info-sheet"
import { PinnedBar } from "@/components/chat/pinned-bar"
import { VoicePlayer } from "@/components/chat/voice-player"
import {
  IMAGE_MAX_BYTES,
  UploadError,
  prepareImage,
  uploadAttachment,
  type AttachmentKind,
} from "@/lib/chat-attachment"
import {
  PinError,
  fetchPins,
  setPinned,
  type PinnedMessage,
} from "@/lib/chat-pins"
import {
  DisappearError,
  disappearLabel,
  setDisappearing,
} from "@/lib/chat-disappearing"
import {
  StarError,
  fetchStars,
  setStarred,
  type StarredMessage,
} from "@/lib/chat-stars"
import {
  useChatSocket,
  type ChatMedia,
  type ChatMessage,
  type ReceiptStatus,
  type ReplyPreview,
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
// "Delete for everyone" is only offered this long after sending (the server
// enforces the same limit; this only decides whether the option is shown).
const DELETE_FOR_EVERYONE_MS = 48 * 60 * 60 * 1000
// Tapping a quote loads older pages until the original is found, but gives up
// after this many pages (30 messages each) instead of loading a whole history.
const MAX_JUMP_PAGES = 20
// How long the original stays highlighted after a jump.
const HIGHLIGHT_MS = 1500
// How much of the original a reply quote shows (the server cuts it the same).
const REPLY_SNIPPET_LENGTH = 120

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
  // Deleted for everyone: no body, no media, shown as a placeholder.
  deleted: boolean
  // The message this one replies to (a short quote), or null.
  replyTo: ReplyPreview | null
  // Starred by me (private).
  starred: boolean
  // Disappearing messages: when this message vanishes from the screen (ISO
  // time on the SERVER clock), or null = never.
  expiresAt: string | null
  error: string | null
}

type DeleteScope = "me" | "everyone"

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
  // The chat's timer in seconds (null = off) and the server's clock now.
  disappearAfterSeconds?: number | null
  serverNow?: string
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

// Waits for React to draw what was just set, so the DOM can be searched.
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function snippet(text: string | null): string | null {
  if (text === null) {
    return null
  }

  const flat = text.replace(/\s+/g, " ").trim()

  return flat.length > REPLY_SNIPPET_LENGTH
    ? `${flat.slice(0, REPLY_SNIPPET_LENGTH - 1)}…`
    : flat
}

// The quote for replying to this bubble. Only a saved, not-deleted message can
// be replied to.
function quoteFromItem(item: Item): ReplyPreview | null {
  if (item.id === null || item.deleted) {
    return null
  }

  return {
    id: item.id,
    fromMe: item.fromMe,
    kind: item.kind,
    body: item.kind === "text" ? snippet(item.body) : null,
    unavailable: false,
  }
}

// One line of text for a quote (in a bubble or above the composer).
function quoteText(reply: ReplyPreview): string {
  if (reply.unavailable) {
    return "Message unavailable"
  }

  if (reply.kind === "image") {
    return "Photo"
  }

  if (reply.kind === "voice") {
    return "Voice message"
  }

  return reply.body ?? ""
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
    deleted: message.deleted,
    replyTo: message.replyTo ?? null,
    starred: message.starred ?? false,
    expiresAt: message.expiresAt ?? null,
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
            // A deleted message never comes back.
            deleted: existing.deleted || message.deleted,
            replyTo: existing.deleted ? null : (message.replyTo ?? null),
            starred: existing.deleted ? false : (message.starred ?? existing.starred),
            expiresAt: message.expiresAt ?? existing.expiresAt,
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

// Disappearing messages. `now` is the SERVER's clock (this device's clock plus
// the measured skew), so a wrong phone clock doesn't make messages vanish early
// or late. A message with no expiresAt never disappears.
function isExpired(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now
}

// Removes expired messages, and turns any reply quoting one into "Message
// unavailable" (the server does the same on a refetch).
function pruneExpired(items: Item[], now: number): Item[] {
  const gone = new Set<number>()

  for (const item of items) {
    if (item.id !== null && isExpired(item.expiresAt, now)) {
      gone.add(item.id)
    }
  }

  if (gone.size === 0) {
    return items
  }

  return items
    .filter((item) => item.id === null || !gone.has(item.id))
    .map((item) =>
      item.replyTo && gone.has(item.replyTo.id) && !item.replyTo.unavailable
        ? { ...item, replyTo: { ...item.replyTo, body: null, unavailable: true } }
        : item
    )
}

// setTimeout can't wait longer than about 24 days; wake up at least this often.
const MAX_TIMER_MS = 60 * 60 * 1000

// Delete for me removes the bubble; delete for everyone keeps it as a
// "This message was deleted" placeholder. Either way, any reply that quotes it
// now shows "Message unavailable" (the server does the same on a refetch).
function applyDeletion(items: Item[], id: number, scope: DeleteScope): Item[] {
  const next =
    scope === "me"
      ? items.filter((item) => item.id !== id)
      : items.map((item) =>
          item.id === id
            ? {
                ...item,
                deleted: true,
                body: null,
                media: null,
                replyTo: null,
                starred: false,
              }
            : item
        )

  return next.map((item) =>
    item.replyTo && item.replyTo.id === id && !item.replyTo.unavailable
      ? {
          ...item,
          replyTo: { ...item.replyTo, body: null, unavailable: true },
        }
      : item
  )
}

// Photos show in one standard frame. The shape follows the photo but is kept
// between portrait 3:4 and landscape 8:5, so a very tall or wide picture never
// takes over the thread (the viewer shows the whole photo).
function frameRatio(
  width: number | null | undefined,
  height: number | null | undefined
): number {
  if (!width || !height) {
    return 4 / 3
  }

  return Math.min(1.6, Math.max(0.75, width / height))
}

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

// The vertical three dots next to a bubble. Hidden until hover on a mouse
// device, always visible on touch screens.
function MessageMenu({
  align,
  pinned,
  starred,
  onReply,
  onTogglePin,
  onToggleStar,
  onDeleteForMe,
  onDeleteForEveryone,
}: {
  align: "start" | "end"
  // Whether this message is pinned right now (the item reads Unpin instead).
  pinned: boolean
  // Whether I starred this message (the item reads Unstar instead).
  starred: boolean
  // Null for a message that can't be replied to, pinned or starred (a deleted one).
  onReply: (() => void) | null
  onTogglePin: (() => void) | null
  onToggleStar: (() => void) | null
  onDeleteForMe: () => void
  onDeleteForEveryone: (() => void) | null
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Message options"
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
          />
        }
      >
        <IconDotsVertical className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {onReply && (
          <DropdownMenuItem onClick={onReply}>
            <IconArrowBackUp aria-hidden="true" />
            Reply
          </DropdownMenuItem>
        )}
        {onTogglePin && (
          <DropdownMenuItem onClick={onTogglePin}>
            {pinned ? (
              <IconPinnedOff aria-hidden="true" />
            ) : (
              <IconPin aria-hidden="true" />
            )}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
        )}
        {onToggleStar && (
          <DropdownMenuItem onClick={onToggleStar}>
            {starred ? (
              <IconStarOff aria-hidden="true" />
            ) : (
              <IconStar aria-hidden="true" />
            )}
            {starred ? "Unstar" : "Star"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onDeleteForMe}>
          <IconTrash aria-hidden="true" />
          Delete for me
        </DropdownMenuItem>
        {onDeleteForEveryone && (
          <DropdownMenuItem variant="destructive" onClick={onDeleteForEveryone}>
            <IconTrash aria-hidden="true" />
            Delete for everyone
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The inside of a photo or voice bubble. While an upload is under way there is
// no server media yet, so a photo is shown from the file on this device.
// `onMediaError` fires when a signed URL has expired (see refreshMedia).
function AttachmentView({
  item,
  onMediaError,
  onOpenImage,
}: {
  item: Item
  onMediaError: () => void
  onOpenImage: (media: ChatMedia) => void
}) {
  const uploading = item.id === null && item.status === "sending"
  const percent = Math.round((item.progress ?? 0) * 100)

  if (item.kind === "image") {
    const media = item.media
    const src = media?.thumbUrl ?? media?.url ?? item.localUrl

    const picture = (
      <div
        style={{ aspectRatio: frameRatio(media?.width, media?.height) }}
        className="relative w-64 max-w-full overflow-hidden bg-muted ring-1 ring-foreground/10"
      >
        {src && (
          <img
            src={src}
            alt="Photo"
            loading="lazy"
            onError={onMediaError}
            className="size-full object-cover"
          />
        )}

        {uploading && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-background/60 text-xs font-medium text-foreground"
          >
            {percent}%
          </div>
        )}
      </div>
    )

    return media ? (
      <button
        type="button"
        aria-label="Open photo"
        onClick={() => onOpenImage(media)}
        className="block cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {picture}
      </button>
    ) : (
      picture
    )
  }

  if (item.media) {
    return (
      <VoicePlayer
        src={item.media.url}
        durationSeconds={item.media.durationSeconds}
        waveform={item.media.waveform}
        seed={item.id ?? 0}
        onError={onMediaError}
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

// Sending anything (text, photo, voice) jumps to the newest message, like
// WhatsApp, even when the person had scrolled up to read older ones. It has to
// be its own component because useMessageScroller only works inside the
// MessageScrollerProvider that the page renders.
function ScrollToEndOnSend({ token }: { token: number }) {
  const { scrollToEnd } = useMessageScroller()

  React.useEffect(() => {
    if (token > 0) {
      scrollToEnd({ behavior: "auto" })
    }
  }, [token, scrollToEnd])

  return null
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

  const [composerError, setComposerError] = React.useState<string | null>(null)
  // Bumped every time I send something, so the thread scrolls to the bottom.
  const [sendToken, setSendToken] = React.useState(0)
  const [floors, setFloors] = React.useState<Floors>({ delivered: 0, read: 0 })

  // The message I am replying to (shown above the composer), and the message
  // that is briefly highlighted after tapping a quote or the pinned bar.
  const [replyingTo, setReplyingTo] = React.useState<Item | null>(null)
  const [highlightId, setHighlightId] = React.useState<number | null>(null)

  // Disappearing messages: this chat's timer (null = off) and the Chat info
  // section state. `skewRef` is (server clock - this device's clock), so
  // messages vanish on the server's time.
  const [disappearAfter, setDisappearAfter] = React.useState<number | null>(null)
  const [disappearBusy, setDisappearBusy] = React.useState(false)
  const [disappearError, setDisappearError] = React.useState<string | null>(null)
  const skewRef = React.useRef(0)
  const [expiryTick, setExpiryTick] = React.useState(0)

  // The pinned messages of this chat (shared by both people), newest pin first.
  const [pins, setPins] = React.useState<PinnedMessage[]>([])

  // The Chat info panel and my starred messages in this chat. `stars` is null
  // until the panel is opened (the list is loaded on demand).
  const [infoOpen, setInfoOpen] = React.useState(false)
  const [stars, setStars] = React.useState<StarredMessage[] | null>(null)
  const [starsFailed, setStarsFailed] = React.useState(false)
  // Read by the socket handler, which must not resubscribe when the panel opens.
  const infoOpenRef = React.useRef(false)

  // The photo open in the full-screen viewer, and the message being deleted.
  const [viewer, setViewer] = React.useState<ChatMedia | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<{
    item: Item
    scope: DeleteScope
  } | null>(null)
  const [messageDeleting, setMessageDeleting] = React.useState(false)
  const [messageDeleteError, setMessageDeleteError] = React.useState<
    string | null
  >(null)

  const abortRef = React.useRef<AbortController | null>(null)
  const nameRef = React.useRef(username)
  const timersRef = React.useRef(new Map<string, number>())
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  // Object URLs for photos being uploaded; all are released when the page closes.
  const objectUrlsRef = React.useRef(new Set<string>())
  const fetchedAtRef = React.useRef(0)
  const mediaErrorAtRef = React.useRef(0)
  // The quote to attach to the next photo or voice note, kept in a ref because
  // the voice recorder calls back with an older copy of this page's state.
  const replyQuoteRef = React.useRef<ReplyPreview | null>(null)
  const cursorRef = React.useRef<number | null>(null)
  const jumpingRef = React.useRef(false)

  const items = state.status === "ready" ? state.items : NO_ITEMS
  const nextCursor = state.status === "ready" ? state.nextCursor : null
  const isFriend = state.status === "ready" ? state.isFriend : false

  // Ids of the pinned messages, for the menu (Pin / Unpin) and the pin icon.
  const pinnedIds = React.useMemo(
    () => new Set(pins.map((pin) => pin.id)),
    [pins]
  )

  React.useEffect(() => {
    cursorRef.current = nextCursor
  }, [nextCursor])

  React.useEffect(() => {
    replyQuoteRef.current = replyingTo ? quoteFromItem(replyingTo) : null
  }, [replyingTo])

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

        if (data.serverNow) {
          const serverMs = new Date(data.serverNow).getTime()

          if (!Number.isNaN(serverMs)) {
            skewRef.current = serverMs - Date.now()
          }
        }

        if (data.disappearAfterSeconds !== undefined) {
          setDisappearAfter(data.disappearAfterSeconds)
        }

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

  // The pinned bar is best effort: if this fails the thread still works, and
  // the next pin event or reconnect tries again.
  const loadPins = React.useCallback(async () => {
    const requestedFor = username

    try {
      const list = await fetchPins(requestedFor)

      if (nameRef.current === requestedFor) {
        setPins(list)
      }
    } catch {
      // Keep whatever is shown.
    }
  }, [username])

  // The starred list is only fetched while the Chat info panel is open.
  const loadStars = React.useCallback(async () => {
    const requestedFor = username

    try {
      const list = await fetchStars(requestedFor)

      if (nameRef.current === requestedFor) {
        setStars(list)
        setStarsFailed(false)
      }
    } catch {
      if (nameRef.current === requestedFor) {
        setStarsFailed(true)
      }
    }
  }, [username])

  // Sets the star flag on a message that is in the list (older ones that are
  // not loaded have no icon to update).
  const patchStar = React.useCallback((id: number, starred: boolean) => {
    setState((previous) =>
      previous.status === "ready"
        ? {
            ...previous,
            items: previous.items.map((item) =>
              item.id === id ? { ...item, starred } : item
            ),
          }
        : previous
    )
  }, [])

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
    setViewer(null)
    setPendingDelete(null)
    setReplyingTo(null)
    setHighlightId(null)
    setPins([])
    setDisappearAfter(null)
    setDisappearBusy(false)
    setDisappearError(null)
    setStars(null)
    setStarsFailed(false)
    infoOpenRef.current = false
    setInfoOpen(false)

    if (!username) {
      setState({ status: "not-found" })
      return
    }

    void loadLatest()
    void loadPins()

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
  }, [username, loadLatest, loadPins])

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
      void loadPins()
      markRead()
    }
  }, [reconnectCount, loadLatest, loadPins, markRead])

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

  // Tapping a quote or the pinned bar: scroll to the original and highlight it.
  // If it is older than what is loaded, load older pages until it shows up (up
  // to MAX_JUMP_PAGES), then scroll to it.
  const jumpToMessage = React.useCallback(
    async (id: number) => {
      if (jumpingRef.current) {
        return
      }

      jumpingRef.current = true

      const requestedFor = username
      const find = () =>
        document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)

      try {
        let element = find()
        let cursor = cursorRef.current
        let pages = 0

        while (!element && cursor !== null && pages < MAX_JUMP_PAGES) {
          const response = await fetch(
            `${API_URL}/api/conversations/${encodeURIComponent(requestedFor)}/messages?limit=${PAGE_SIZE}&before=${cursor}`,
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

          cursor = data.nextCursor
          pages += 1

          await nextPaint()
          element = find()
        }

        if (!element) {
          setComposerError("That message is no longer available.")
          return
        }

        element.scrollIntoView({ block: "center", behavior: "smooth" })
        setHighlightId(id)
        window.setTimeout(
          () => setHighlightId((current) => (current === id ? null : current)),
          HIGHLIGHT_MS
        )
      } catch {
        setComposerError("Could not load older messages. Try again.")
      } finally {
        jumpingRef.current = false
      }
    },
    [username]
  )

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
    (body: string, replyTo: ReplyPreview | null) => {
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
        deleted: false,
        starred: false,
        expiresAt: null, // the server stamps it; the live message brings it
        replyTo,
        error: null,
      }

      setState((previous) =>
        previous.status === "ready"
          ? { ...previous, items: [...previous.items, item] }
          : previous
      )
      setSendToken((token) => token + 1)

      if (!send(username, body, clientId, replyTo?.id)) {
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

    const quote = replyingTo ? quoteFromItem(replyingTo) : null

    setDraft("")
    setReplyingTo(null)
    sendBody(body, quote)
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
      void sendAttachment(
        item.upload.kind,
        item.upload.file,
        item.upload.fileName,
        item.replyTo
      )
    } else if (item.body !== null) {
      sendBody(item.body, item.replyTo)
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
    async (
      kind: AttachmentKind,
      file: Blob,
      fileName: string,
      replyTo: ReplyPreview | null
    ) => {
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
        deleted: false,
        starred: false,
        expiresAt: null,
        replyTo,
        error: null,
      }

      setComposerError(null)
      setState((previous) =>
        previous.status === "ready"
          ? { ...previous, items: [...previous.items, pending] }
          : previous
      )
      setSendToken((token) => token + 1)

      // A failed upload keeps its preview so Retry can show it again.
      let keepPreview = false

      try {
        const message = await uploadAttachment({
          username: requestedFor,
          kind,
          file,
          fileName,
          replyToId: replyTo?.id ?? null,
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

    // Taken now, before the (slow) resize, in case the reply changes meanwhile.
    const quote = replyQuoteRef.current
    const prepared = await prepareImage(file)

    if (prepared.size > IMAGE_MAX_BYTES) {
      setComposerError("That photo is too large. Photos can be up to 5 MB.")
      return
    }

    const name = prepared.type === "image/webp" ? "photo.webp" : file.name

    setReplyingTo(null)
    void sendAttachment("image", prepared, name, quote)
  }

  const onVoiceFinished = React.useCallback(
    (voice: RecordedVoice) => {
      const quote = replyQuoteRef.current

      setReplyingTo(null)
      void sendAttachment("voice", voice.blob, voice.fileName, quote)
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

  // Disappearing messages, live: wake up when the next message expires and
  // remove everything that is due (from the thread, the pinned bar, the open
  // Chat info list and an open reply). Also checks when the tab comes back.
  const nextExpiry = React.useMemo(() => {
    let earliest: number | null = null

    for (const item of items) {
      if (item.id !== null && item.expiresAt) {
        const at = new Date(item.expiresAt).getTime()

        if (earliest === null || at < earliest) {
          earliest = at
        }
      }
    }

    return earliest
  }, [items])

  React.useEffect(() => {
    function prune() {
      const now = Date.now() + skewRef.current

      setState((previous) =>
        previous.status === "ready"
          ? { ...previous, items: pruneExpired(previous.items, now) }
          : previous
      )
      setPins((current) => {
        const next = current.filter((pin) => !isExpired(pin.expiresAt, now))
        return next.length === current.length ? current : next
      })
      setStars((current) => {
        if (!current) {
          return current
        }

        const next = current.filter((star) => !isExpired(star.expiresAt, now))
        return next.length === current.length ? current : next
      })
      setReplyingTo((current) =>
        current && isExpired(current.expiresAt, now) ? null : current
      )
      setExpiryTick((tick) => tick + 1)
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        prune()
      }
    }

    document.addEventListener("visibilitychange", onVisible)

    let timer: number | undefined

    if (nextExpiry !== null) {
      const wait = Math.min(
        Math.max(nextExpiry - (Date.now() + skewRef.current), 0) + 50,
        MAX_TIMER_MS
      )

      timer = window.setTimeout(prune, wait)
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.clearTimeout(timer)
    }
  }, [nextExpiry, expiryTick])

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

      // I starred or unstarred a message in another tab.
      if (event.type === "message_starred") {
        if (event.username === username) {
          patchStar(event.id, event.starred)

          if (infoOpenRef.current) {
            void loadStars()
          }
        }

        return
      }

      // Either of us changed the disappearing-messages timer. Only new messages
      // are affected, so nothing on screen changes except the header.
      if (event.type === "disappearing_changed") {
        if (event.username === username) {
          setDisappearAfter(event.afterSeconds)
          setDisappearError(null)
        }

        return
      }

      // A message was pinned or unpinned, by me in another tab or by them.
      if (event.type === "message_pinned") {
        if (event.username === username) {
          void loadPins()
        }

        return
      }

      // A message was deleted, here or in another tab, or by the other person.
      if (event.type === "message_deleted") {
        if (event.username === username) {
          const deletedId = event.id

          setState((previous) =>
            previous.status === "ready"
              ? {
                  ...previous,
                  items: applyDeletion(previous.items, deletedId, event.scope),
                }
              : previous
          )

          // Don't keep a reply open to a message that no longer exists, and a
          // deleted message can't stay in the pinned bar.
          setReplyingTo((current) =>
            current && current.id === deletedId ? null : current
          )
          setPins((current) => current.filter((pin) => pin.id !== deletedId))
          setStars((current) =>
            current ? current.filter((star) => star.id !== deletedId) : current
          )
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
  }, [
    subscribe,
    username,
    clearTimer,
    patchItem,
    markRead,
    loadPins,
    loadStars,
    patchStar,
  ])

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

  // One message: "for me" hides it on this account, "for everyone" (sender only,
  // within 48 hours) replaces it with a placeholder for both people.
  async function confirmDeleteMessage() {
    if (!pendingDelete || pendingDelete.item.id === null) {
      return
    }

    const { item, scope } = pendingDelete
    const id = item.id as number

    setMessageDeleting(true)
    setMessageDeleteError(null)

    try {
      const response = await fetch(`${API_URL}/api/messages/${id}?scope=${scope}`, {
        method: "DELETE",
        credentials: "include",
      })

      if (response.status === 401) {
        setPendingDelete(null)
        setState({ status: "unauthenticated" })
        return
      }

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          message?: string
        } | null

        throw new Error(
          typeof data?.message === "string" && data.message
            ? data.message
            : "Could not delete the message. Try again."
        )
      }

      setState((previous) =>
        previous.status === "ready"
          ? { ...previous, items: applyDeletion(previous.items, id, scope) }
          : previous
      )
      setReplyingTo((current) =>
        current && current.id === id ? null : current
      )
      setPins((current) => current.filter((pin) => pin.id !== id))
      setStars((current) =>
        current ? current.filter((star) => star.id !== id) : current
      )
      setPendingDelete(null)
    } catch (error) {
      setMessageDeleteError(
        error instanceof Error
          ? error.message
          : "Could not delete the message. Try again."
      )
    } finally {
      setMessageDeleting(false)
    }
  }

  function askDelete(item: Item, scope: DeleteScope) {
    setMessageDeleteError(null)
    setPendingDelete({ item, scope })
  }

  /* ----------------------------- star ------------------------------ */

  function setInfo(open: boolean) {
    infoOpenRef.current = open
    setInfoOpen(open)
  }

  // Changes the shared disappearing timer. The server tells both people (the
  // socket event updates the header); the radio moves here once it is saved.
  async function changeDisappear(seconds: number | null) {
    const requestedFor = username

    setDisappearBusy(true)
    setDisappearError(null)

    try {
      await setDisappearing(requestedFor, seconds)

      if (nameRef.current === requestedFor) {
        setDisappearAfter(seconds)
      }
    } catch (error) {
      if (nameRef.current === requestedFor) {
        setDisappearError(
          error instanceof DisappearError
            ? error.message
            : "Could not change disappearing messages. Try again."
        )
      }
    } finally {
      if (nameRef.current === requestedFor) {
        setDisappearBusy(false)
      }
    }
  }

  // Opens the Chat info panel and loads my stars for this chat.
  function openInfo() {
    setStarsFailed(false)
    setInfo(true)
    void loadStars()
  }

  // Stars or unstars one saved message. The icon changes at once and is put
  // back if the server says no. Stars are private, so no one else is told.
  async function toggleStar(item: Item, star: boolean) {
    if (item.id === null) {
      return
    }

    const id = item.id

    setComposerError(null)
    patchStar(id, star)

    try {
      await setStarred(id, star)

      if (infoOpenRef.current) {
        void loadStars()
      }
    } catch (error) {
      patchStar(id, !star)
      setComposerError(
        error instanceof StarError
          ? error.message
          : "Could not update the star. Try again."
      )
    }
  }

  // Unstar from the panel (the message may be older than what is loaded).
  async function unstarFromPanel(id: number) {
    setStars((current) =>
      current ? current.filter((star) => star.id !== id) : current
    )
    patchStar(id, false)

    try {
      await setStarred(id, false)
    } catch (error) {
      patchStar(id, true)
      void loadStars()
      setComposerError(
        error instanceof StarError
          ? error.message
          : "Could not unstar the message. Try again."
      )
    }
  }

  // Unpin from the panel: the same request as the message menu.
  async function unpinFromPanel(id: number) {
    setComposerError(null)

    try {
      await setPinned(id, false)
      await loadPins()
    } catch (error) {
      setComposerError(
        error instanceof PinError
          ? error.message
          : "Could not update the pin. Try again."
      )
    }
  }

  /* ------------------------------ pin ------------------------------ */

  // Pins or unpins one saved message, then refreshes the bar. The server also
  // pushes a message_pinned event to both people, so the other person's bar
  // updates too. A full chat (3 pins) shows the server's own message.
  async function togglePin(item: Item, pin: boolean) {
    if (item.id === null) {
      return
    }

    setComposerError(null)

    try {
      await setPinned(item.id, pin)
      await loadPins()
    } catch (error) {
      setComposerError(
        error instanceof PinError
          ? error.message
          : "Could not update the pin. Try again."
      )
    }
  }

  /* ---------------------------- render ----------------------------- */

  if (state.status === "loading") {
    return <ChatThreadSkeleton />
  }

  if (state.status === "unauthenticated") {
    return (
      <Empty role="alert" className="mx-auto max-w-2xl">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconLock aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Session expired</EmptyTitle>
          <EmptyDescription>
            Your session expired. Sign in again to see this chat.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" nativeButton={false} render={<Link to="/sign-in" />}>
            Sign in
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (state.status === "not-found") {
    return (
      <Empty role="alert" className="mx-auto max-w-2xl">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconMessageOff aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Conversation not available</EmptyTitle>
          <EmptyDescription>
            This conversation is not available.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/chats" />}
          >
            Back to chats
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (state.status === "error") {
    return (
      <Empty role="alert" className="mx-auto max-w-2xl">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconAlertCircle aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Could not load this chat</EmptyTitle>
          <EmptyDescription>
            Check your connection and try again.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={() => void loadLatest()}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
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
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to chats"
          nativeButton={false}
          render={<Link to="/chats" />}
        >
          <IconArrowLeft aria-hidden="true" />
        </Button>

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

        {disappearAfter !== null && (
          <button
            type="button"
            onClick={openInfo}
            aria-label={`Disappearing messages: ${disappearLabel(disappearAfter)}. Open chat info`}
            title={`Disappearing messages: ${disappearLabel(disappearAfter)}`}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <IconClock className="size-4" aria-hidden="true" />
            {disappearLabel(disappearAfter)}
          </button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Chat options"
            render={<Button variant="ghost" size="icon" />}
          >
            <IconDotsVertical aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={openInfo}>
              <IconInfoCircle aria-hidden="true" />
              Chat info
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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

      {/* Pinned messages of this chat. Tapping jumps to the message. */}
      <PinnedBar pins={pins} onJump={(id) => void jumpToMessage(id)} />

      {socketStatus === "closed" && (
        <Alert
          role="status"
          className="shrink-0 justify-items-center rounded-none border-x-0 border-t-0 bg-muted py-1.5"
        >
          <AlertDescription className="justify-items-center">
            Reconnecting. Messages may fail to send.
          </AlertDescription>
        </Alert>
      )}

      <MessageScrollerProvider autoScroll>
        <ScrollToEndOnSend token={sendToken} />

        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            {/* justify-end keeps a short thread at the bottom, like WhatsApp. */}
            <MessageScrollerContent className="justify-end px-3 py-4 sm:px-6">
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
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <IconMessage aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No messages yet</EmptyTitle>
                    <EmptyDescription>Say hello to @{username}.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}

              {items.map((item, index) => {
                const showDay =
                  index === 0 ||
                  !isSameDay(items[index - 1].createdAt, item.createdAt)
                const align = item.fromMe ? "end" : "start"

                // Only saved messages have a menu. Delete for everyone is for
                // my own messages, within 48 hours, and not already deleted.
                const canMenu = item.status === "sent" && item.id !== null
                const isPhoto = item.kind === "image" && !item.deleted
                const isPinned = item.id !== null && pinnedIds.has(item.id)
                const canDeleteForEveryone =
                  canMenu &&
                  item.fromMe &&
                  !item.deleted &&
                  Date.now() - new Date(item.createdAt).getTime() <
                    DELETE_FOR_EVERYONE_MS

                const menu = canMenu ? (
                  <MessageMenu
                    align={item.fromMe ? "end" : "start"}
                    pinned={isPinned}
                    starred={item.starred}
                    onReply={item.deleted ? null : () => setReplyingTo(item)}
                    onTogglePin={
                      item.deleted ? null : () => void togglePin(item, !isPinned)
                    }
                    onToggleStar={
                      item.deleted
                        ? null
                        : () => void toggleStar(item, !item.starred)
                    }
                    onDeleteForMe={() => askDelete(item, "me")}
                    onDeleteForEveryone={
                      canDeleteForEveryone
                        ? () => askDelete(item, "everyone")
                        : null
                    }
                  />
                ) : null

                const reply = item.deleted ? null : item.replyTo

                return (
                  <React.Fragment key={item.key}>
                    {showDay && (
                      <div className="my-3 flex justify-center">
                        <Badge variant="secondary" className="rounded-full px-3">
                          {formatDayLabel(item.createdAt)}
                        </Badge>
                      </div>
                    )}

                    {/* No scrollAnchor: it pins a new message to the TOP of the
                        view with blank space below (AI-chat behavior). A chat
                        wants the newest message at the bottom. */}
                    <MessageScrollerItem messageId={item.key}>
                      <Message align={align}>
                        <MessageContent>
                          {/* The quote of the message this one replies to. Tap
                              it to jump to the original. */}
                          {reply && (
                            <div
                              className={cn(
                                "flex",
                                item.fromMe ? "justify-end" : "justify-start"
                              )}
                            >
                              <button
                                type="button"
                                disabled={reply.unavailable}
                                aria-label="Go to the original message"
                                onClick={() => void jumpToMessage(reply.id)}
                                className="mb-1 flex min-w-0 max-w-[80%] flex-col gap-0.5 border-l-2 border-primary bg-muted px-2 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer enabled:hover:bg-muted/70"
                              >
                                <span className="font-medium">
                                  {reply.fromMe ? "You" : `@${username}`}
                                </span>
                                <span
                                  className={cn(
                                    "truncate text-muted-foreground",
                                    reply.unavailable && "italic"
                                  )}
                                >
                                  {quoteText(reply)}
                                </span>
                              </button>
                            </div>
                          )}

                          <div
                            data-message-id={item.id ?? undefined}
                            className={cn(
                              "group/msg flex items-center gap-1",
                              item.fromMe ? "justify-end" : "justify-start"
                            )}
                          >
                            {item.fromMe && menu}

                            {/* The colored background comes from the Bubble
                                variant (it paints the content, not this box).
                                A photo uses the "ghost" variant: no background,
                                no padding, so the picture is not framed. */}
                            <Bubble
                              align={align}
                              variant={
                                isPhoto
                                  ? "ghost"
                                  : item.fromMe && !item.deleted
                                    ? undefined
                                    : "muted"
                              }
                              className={cn(
                                item.deleted && "text-muted-foreground",
                                item.status !== "sent" && "opacity-70",
                                item.id !== null &&
                                  highlightId === item.id &&
                                  "ring-2 ring-primary"
                              )}
                            >
                              {item.deleted ? (
                                <BubbleContent className="flex items-center gap-1.5 italic">
                                  <IconBan
                                    className="size-4 shrink-0"
                                    aria-hidden="true"
                                  />
                                  This message was deleted
                                </BubbleContent>
                              ) : item.kind === "text" ? (
                                <BubbleContent className=" whitespace-pre-wrap break-words">
                                  {item.body}
                                </BubbleContent>
                              ) : (
                                <BubbleContent
                                  className={
                                    isPhoto ? "" : " px-2 py-1.5"
                                  }
                                >
                                  <AttachmentView
                                    item={item}
                                    onMediaError={refreshMedia}
                                    onOpenImage={setViewer}
                                  />
                                </BubbleContent>
                              )}
                            </Bubble>

                            {!item.fromMe && menu}
                          </div>

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
                                <Button
                                  variant="link"
                                  size="xs"
                                  className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => retry(item)}
                                >
                                  Retry
                                </Button>
                                <Button
                                  variant="link"
                                  size="xs"
                                  className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => discard(item)}
                                >
                                  Discard
                                </Button>
                              </>
                            )}

                            {item.status === "sent" && (
                              <>
                                {isPinned && !item.deleted && (
                                  <span
                                    role="img"
                                    aria-label="Pinned"
                                    title="Pinned"
                                    className="inline-flex items-center"
                                  >
                                    <IconPin
                                      className="size-3.5"
                                      aria-hidden="true"
                                    />
                                  </span>
                                )}
                                {item.starred && !item.deleted && (
                                  <span
                                    role="img"
                                    aria-label="Starred"
                                    title="Starred"
                                    className="inline-flex items-center"
                                  >
                                    <IconStar
                                      className="size-3.5 fill-current"
                                      aria-hidden="true"
                                    />
                                  </span>
                                )}
                                <time dateTime={item.createdAt}>
                                  {formatClock(item.createdAt)}
                                </time>
                                {item.fromMe && !item.deleted && (
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

          {/* Only visible once the person scrolls away from the newest message. */}
          <MessageScrollerButton
            size="icon"
            className=" shadow-md"
          />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* shrink-0 keeps the composer in place; the bottom padding clears the
          iPhone home bar (needs viewport-fit=cover in index.html). */}
      <div className="shrink-0 border-t bg-card p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3">
        {(composerError ?? recorder.error) && (
          <Alert variant="destructive" className="mb-2">
            <AlertDescription>{composerError ?? recorder.error}</AlertDescription>
          </Alert>
        )}

        {/* Who and what I am replying to. Sending (text, photo or voice note)
            attaches it and closes this bar. */}
        {replyingTo && (
          <div className="mb-2 flex items-center gap-2 border-l-2 border-primary bg-muted px-3 py-1.5 text-xs">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">
                {replyingTo.fromMe
                  ? "Replying to yourself"
                  : `Replying to @${username}`}
              </span>
              <span className="truncate text-muted-foreground">
                {replyingTo.kind === "image"
                  ? "Photo"
                  : replyingTo.kind === "voice"
                    ? "Voice message"
                    : snippet(replyingTo.body)}
              </span>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label="Cancel reply"
              onClick={() => setReplyingTo(null)}
            >
              <IconX className="size-4" aria-hidden="true" />
            </Button>
          </div>
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
          <InputGroup className="h-auto rounded-2xl bg-background p-1.5 shadow-xs">
            <InputGroupAddon className="py-0">
              <InputGroupButton
                className="size-9 rounded-full"
                aria-label="Cancel recording"
                onClick={recorder.cancel}
              >
                <IconTrash className="size-5" aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>

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

            <InputGroupAddon align="inline-end" className="py-0">
              <InputGroupButton
                variant="default"
                className="size-9 rounded-full"
                aria-label="Send voice message"
                onClick={recorder.stop}
              >
                <IconSend className="size-5" aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : (
          <InputGroup className="items-end bg-background p-1.5 shadow-xs">
            {isFriend && (
              <InputGroupAddon className="py-0">
                <InputGroupButton
                  className="size-9 rounded-full"
                  aria-label="Send a photo"
                  onClick={() => {
                    setComposerError(null)
                    fileInputRef.current?.click()
                  }}
                >
                  <IconPhoto className="size-5" aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            )}

            {/* min-h-9 and py-2 match the 36px buttons, so one line is
                centered and the box grows upward from there. text-base on
                mobile: iPhone Safari zooms the page on focus when an input's
                text is under 16px. */}
            <InputGroupTextarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={`Message @${username}`}
              aria-label="Message"
              rows={1}
              maxLength={MAX_LENGTH}
              className="max-h-32 min-h-9 min-w-0 px-2 py-2 text-base leading-5 md:text-sm"
            />

            {/* With nothing typed, a friend gets the microphone; as soon as
                there is text, it turns into Send. */}
            <InputGroupAddon align="inline-end" className="py-0">
              {isFriend && recorder.supported && draft.trim() === "" ? (
                <InputGroupButton
                  className="size-9 rounded-full"
                  aria-label="Record a voice message"
                  disabled={recorder.state === "starting"}
                  onClick={() => {
                    setComposerError(null)
                    void recorder.start()
                  }}
                >
                  <IconMicrophone className="size-5" aria-hidden="true" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  variant="default"
                  className="size-9 rounded-full"
                  aria-label="Send message"
                  disabled={draft.trim() === ""}
                  onClick={submit}
                >
                  <IconSend className="size-5" aria-hidden="true" />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        )}
      </div>

      {/* Chat info: my stars (private) and the pins (shared). Tapping a row
          closes the panel and jumps to that message. */}
      <ChatInfoSheet
        open={infoOpen}
        onOpenChange={setInfo}
        username={username}
        stars={stars}
        starsFailed={starsFailed}
        pins={pins}
        onJump={(id) => {
          setInfo(false)
          void jumpToMessage(id)
        }}
        onUnstar={(id) => void unstarFromPanel(id)}
        onUnpin={(id) => void unpinFromPanel(id)}
        onRetryStars={() => {
          setStarsFailed(false)
          void loadStars()
        }}
        disappearAfter={disappearAfter}
        disappearBusy={disappearBusy}
        disappearError={disappearError}
        onChangeDisappear={(seconds) => void changeDisappear(seconds)}
      />

      {viewer && (
        <MediaViewer
          src={viewer.url}
          onClose={() => setViewer(null)}
          onError={refreshMedia}
        />
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !messageDeleting) {
            setPendingDelete(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.scope === "everyone"
                ? "Delete for everyone?"
                : "Delete for you?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.scope === "everyone"
                ? `This replaces the message with "This message was deleted" for you and @${username}. You can only do this within 48 hours of sending.`
                : `This removes the message from your chat only. @${username} can still see it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {messageDeleteError && (
            <p role="alert" className="text-sm text-destructive">
              {messageDeleteError}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={messageDeleting}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={messageDeleting}
              onClick={() => void confirmDeleteMessage()}
            >
              {messageDeleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
