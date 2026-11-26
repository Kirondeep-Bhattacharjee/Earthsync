import { IconPinnedOff, IconStarOff } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { PinnedMessage } from "@/lib/chat-pins"
import type { StarredMessage } from "@/lib/chat-stars"

// The "Chat info" panel, opened from the chat header menu. It lists this chat's
// starred messages (private to me) and pinned messages (shared). Tapping a row
// jumps to that message in the thread. The disappearing-messages timer will be
// added here as a third section.

type Row = {
  id: number
  fromMe: boolean
  kind: "text" | "image" | "voice"
  body: string | null
  createdAt: string
}

function label(row: Row): string {
  if (row.kind === "image") {
    return "Photo"
  }

  if (row.kind === "voice") {
    return "Voice message"
  }

  return row.body ?? ""
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

function MessageRow({
  row,
  username,
  actionLabel,
  icon,
  onJump,
  onAction,
}: {
  row: Row
  username: string
  actionLabel: string
  icon: React.ReactNode
  onJump: (id: number) => void
  onAction: (id: number) => void
}) {
  return (
    <li className="flex items-center gap-1 border-b last:border-b-0">
      <button
        type="button"
        onClick={() => onJump(row.id)}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-1 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-xs font-medium">
          {row.fromMe ? "You" : `@${username}`}
        </span>
        <span className="line-clamp-2 break-words text-muted-foreground">
          {label(row)}
        </span>
        <span className="text-[0.7rem] text-muted-foreground">
          {formatWhen(row.createdAt)}
        </span>
      </button>

      <Button
        variant="ghost"
        size="icon"
        aria-label={actionLabel}
        title={actionLabel}
        className="shrink-0 text-muted-foreground"
        onClick={() => onAction(row.id)}
      >
        {icon}
      </Button>
    </li>
  )
}

export function ChatInfoSheet({
  open,
  onOpenChange,
  username,
  stars,
  starsFailed,
  pins,
  onJump,
  onUnstar,
  onUnpin,
  onRetryStars,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  username: string
  // null while the list is loading.
  stars: StarredMessage[] | null
  starsFailed: boolean
  pins: PinnedMessage[]
  onJump: (id: number) => void
  onUnstar: (id: number) => void
  onUnpin: (id: number) => void
  onRetryStars: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0">
        <SheetHeader className="border-b">
          <SheetTitle>Chat info</SheetTitle>
          <SheetDescription>@{username}</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
          <section aria-labelledby="starred-heading" className="flex flex-col gap-2">
            <h3 id="starred-heading" className="text-xs font-medium">
              Starred messages
              {stars && stars.length > 0 ? ` (${stars.length})` : ""}
            </h3>

            {starsFailed ? (
              <div className="flex flex-col items-start gap-2 text-muted-foreground">
                <p>Could not load starred messages.</p>
                <Button size="sm" variant="outline" onClick={onRetryStars}>
                  Try again
                </Button>
              </div>
            ) : stars === null ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : stars.length === 0 ? (
              <p className="text-muted-foreground">
                No starred messages. Open a message's menu and choose Star. Only
                you can see your stars.
              </p>
            ) : (
              <ul>
                {stars.map((star) => (
                  <MessageRow
                    key={star.id}
                    row={star}
                    username={username}
                    actionLabel="Unstar message"
                    icon={<IconStarOff aria-hidden="true" />}
                    onJump={onJump}
                    onAction={onUnstar}
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="pinned-heading" className="flex flex-col gap-2">
            <h3 id="pinned-heading" className="text-xs font-medium">
              Pinned messages{pins.length > 0 ? ` (${pins.length})` : ""}
            </h3>

            {pins.length === 0 ? (
              <p className="text-muted-foreground">
                No pinned messages. Both of you see pins.
              </p>
            ) : (
              <ul>
                {pins.map((pin) => (
                  <MessageRow
                    key={pin.id}
                    row={pin}
                    username={username}
                    actionLabel="Unpin message"
                    icon={<IconPinnedOff aria-hidden="true" />}
                    onJump={onJump}
                    onAction={onUnpin}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
