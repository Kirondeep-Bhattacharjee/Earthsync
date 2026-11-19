import { Link } from "react-router-dom"
import { IconLock } from "@tabler/icons-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { formatMessageTime } from "@/lib/format-time"
import { cn } from "@/lib/utils"

// One item of GET /api/conversations.
export type Conversation = {
  username: string
  visibility: "public" | "private"
  profilePictureUrl: string | null
  isFriend: boolean
  // True when the other person sent something newer than my read marker.
  unread: boolean
  lastMessageAt: string
  lastMessage: {
    body: string
    fromMe: boolean
    createdAt: string
  } | null
}

type ConversationRowProps = {
  conversation: Conversation
}

// The preview is a single line, so line breaks in the message become spaces.
function previewText(conversation: Conversation): string {
  const { lastMessage } = conversation

  if (!lastMessage) {
    return "No messages yet"
  }

  const body = lastMessage.body.replace(/\s+/g, " ").trim()

  return lastMessage.fromMe ? `You: ${body}` : body
}

export function ConversationRow({ conversation }: ConversationRowProps) {
  const { username, visibility, profilePictureUrl, unread } = conversation

  return (
    <Link
      to={`/chats/${username}`}
      className={cn(
        "relative flex items-center gap-3 p-4 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        unread
          ? "bg-primary/5 hover:bg-primary/10 focus-visible:bg-primary/10"
          : "hover:bg-muted/50 focus-visible:bg-muted/50"
      )}
    >
      {/* Accent bar on the left edge: the "glow" for a row that is not read yet. */}
      {unread && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1 bg-primary"
        />
      )}

      <Avatar className="size-10">
        {profilePictureUrl && (
          <AvatarImage src={profilePictureUrl} alt="" />
        )}
        <AvatarFallback>{username.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate",
              unread
                ? "font-semibold text-foreground"
                : "font-normal text-foreground/70"
            )}
          >
            @{username}
          </span>
          {visibility === "private" && (
            <Badge variant="secondary" className="shrink-0 gap-1">
              <IconLock className="size-3" aria-hidden="true" />
              Private
            </Badge>
          )}
        </div>
        <p
          className={cn(
            "truncate text-sm",
            unread ? "font-medium text-foreground" : "text-muted-foreground"
          )}
        >
          {previewText(conversation)}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5 self-start">
        <time
          dateTime={
            conversation.lastMessage?.createdAt ?? conversation.lastMessageAt
          }
          className={cn(
            "text-xs",
            unread ? "font-medium text-foreground" : "text-muted-foreground"
          )}
        >
          {formatMessageTime(
            conversation.lastMessage?.createdAt ?? conversation.lastMessageAt
          )}
        </time>

        {unread && (
          <>
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full bg-primary"
            />
            <span className="sr-only">Unread message</span>
          </>
        )}
      </div>
    </Link>
  )
}