import * as React from "react"
import { Link, useSearchParams } from "react-router-dom"
import { IconMessages } from "@tabler/icons-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ConversationRow,
  type Conversation,
} from "@/components/conversation-row"
import { ChatsSkeleton } from "@/components/skeletons/chats-skeleton"
import {
  useChatSocket,
  type ChatMessage,
  type ServerEvent,
} from "@/lib/chat-socket"

const API_URL = import.meta.env.VITE_API_URL ?? ""

type LoadState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error" }
  | { status: "ready"; conversations: Conversation[] }

type Tab = "friends" | "public"

// A new message in a thread that is already listed: update the preview, move
// the thread to the top (where the server would sort it) and, when it came from
// the other person, mark the thread unread. My own messages never make a
// thread unread, so they leave the flag as it was.
function applyMessage(
  conversations: Conversation[],
  username: string,
  message: ChatMessage
): Conversation[] {
  const index = conversations.findIndex((item) => item.username === username)

  if (index === -1) {
    return conversations
  }

  const updated: Conversation = {
    ...conversations[index],
    unread: message.fromMe ? conversations[index].unread : true,
    lastMessageAt: message.createdAt,
    lastMessage: {
      body: message.body,
      fromMe: message.fromMe,
      createdAt: message.createdAt,
    },
  }

  return [
    updated,
    ...conversations.slice(0, index),
    ...conversations.slice(index + 1),
  ]
}

export default function Chats() {
  const [state, setState] = React.useState<LoadState>({ status: "loading" })
  const [searchParams, setSearchParams] = useSearchParams()
  const { status: socketStatus, reconnectCount, subscribe } = useChatSocket()

  const tab: Tab = searchParams.get("tab") === "public" ? "public" : "friends"

  const abortRef = React.useRef<AbortController | null>(null)
  const stateRef = React.useRef(state)

  React.useEffect(() => {
    stateRef.current = state
  }, [state])

  // `quiet` refetches without the skeleton and keeps what is on screen if it
  // fails, so a live update never replaces the list with an error.
  const load = React.useCallback(async (options: { quiet?: boolean } = {}) => {
    abortRef.current?.abort()

    const controller = new AbortController()
    abortRef.current = controller

    if (!options.quiet) {
      setState({ status: "loading" })
    }

    try {
      const response = await fetch(`${API_URL}/api/conversations`, {
        credentials: "include",
        signal: controller.signal,
      })

      if (response.status === 401) {
        setState({ status: "unauthenticated" })
        return
      }

      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`)
      }

      const data = (await response.json()) as { conversations: Conversation[] }

      setState({ status: "ready", conversations: data.conversations })
    } catch {
      if (controller.signal.aborted || options.quiet) {
        return
      }

      setState({ status: "error" })
    }
  }, [])

  React.useEffect(() => {
    void load()

    return () => abortRef.current?.abort()
  }, [load])

  // The socket came back after a drop: refetch what was missed.
  React.useEffect(() => {
    if (reconnectCount > 0) {
      void load({ quiet: true })
    }
  }, [reconnectCount, load])

  // Something changed what is read (a thread was opened and marked read, maybe
  // in another tab): refetch so the highlights are right. This also covers
  // coming back from a thread before its read request had finished.
  React.useEffect(() => {
    const refresh = () => void load({ quiet: true })

    window.addEventListener("chats:unread-changed", refresh)

    return () => window.removeEventListener("chats:unread-changed", refresh)
  }, [load])

  // Live updates. A thread that is not listed (a new chat, or one that was
  // deleted and came back) needs the server for `isFriend`, so it refetches.
  React.useEffect(() => {
    return subscribe((event: ServerEvent) => {
      if (event.type !== "message") {
        return
      }

      const current = stateRef.current

      if (current.status !== "ready") {
        return
      }

      const known = current.conversations.some(
        (item) => item.username === event.username
      )

      if (!known) {
        void load({ quiet: true })
        return
      }

      setState((previous) =>
        previous.status === "ready"
          ? {
              status: "ready",
              conversations: applyMessage(
                previous.conversations,
                event.username,
                event.chatMessage
              ),
            }
          : previous
      )
    })
  }, [subscribe, load])

  function changeTab(value: unknown) {
    setSearchParams(value === "public" ? { tab: "public" } : {}, {
      replace: true,
    })
  }

  const conversations = state.status === "ready" ? state.conversations : []
  const friends = conversations.filter((item) => item.isFriend)
  const others = conversations.filter((item) => !item.isFriend)
  const friendsUnread = friends.some((item) => item.unread)
  const othersUnread = others.some((item) => item.unread)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        <p className="text-sm text-muted-foreground">
          Your conversations, newest first.
        </p>
      </div>

      {socketStatus === "closed" && state.status === "ready" && (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnecting. New messages may be delayed.
        </p>
      )}

      {state.status === "loading" && <ChatsSkeleton />}

      {state.status === "unauthenticated" && (
        <div role="alert" className="flex flex-col items-start gap-3 text-sm">
          <p>Your session expired. Sign in again to see your chats.</p>
          <Link to="/sign-in" className={buttonVariants({ size: "sm" })}>
            Sign in
          </Link>
        </div>
      )}

      {state.status === "error" && (
        <div role="alert" className="flex flex-col items-start gap-3 text-sm">
          <p>Could not load your chats. Check your connection and try again.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {state.status === "ready" && (
        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList>
            <TabsTrigger value="friends">
              Friends ({friends.length})
              {friendsUnread && <UnreadDot />}
            </TabsTrigger>
            <TabsTrigger value="public">
              Public ({others.length})
              {othersUnread && <UnreadDot />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="friends" className="mt-4">
            {friends.length === 0 ? (
              <EmptyTab
                title="No chats with friends yet"
                description="Open a friend’s profile and press Message to start a chat."
                actionLabel="Go to Friends"
                actionTo="/friends"
              />
            ) : (
              <ConversationList conversations={friends} />
            )}
          </TabsContent>

          <TabsContent value="public" className="mt-4">
            {others.length === 0 ? (
              <EmptyTab
                title="No chats with other people yet"
                description="Chats with people you are not friends with show up here, whether they message you or you message them."
                actionLabel="Find people"
                actionTo="/connect"
              />
            ) : (
              <ConversationList conversations={others} />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

// Shown on a tab label when that tab has an unread thread, so a new message in
// the tab you are not looking at is still noticed.
function UnreadDot() {
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-1.5 inline-block size-2 rounded-full bg-primary"
      />
      <span className="sr-only">, has unread messages</span>
    </>
  )
}

function ConversationList({
  conversations,
}: {
  conversations: Conversation[]
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">
      {conversations.map((conversation) => (
        <li key={conversation.username}>
          <ConversationRow conversation={conversation} />
        </li>
      ))}
    </ul>
  )
}

type EmptyTabProps = {
  title: string
  description: string
  actionLabel: string
  actionTo: string
}

function EmptyTab({ title, description, actionLabel, actionTo }: EmptyTabProps) {
  return (
    <Empty className="rounded-xl border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconMessages />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <Link
        to={actionTo}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {actionLabel}
      </Link>
    </Empty>
  )
}