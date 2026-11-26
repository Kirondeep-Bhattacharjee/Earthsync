import * as React from "react"
import { IconPin } from "@tabler/icons-react"
import type { PinnedMessage } from "@/lib/chat-pins"

// The slim bar under the chat header. It shows one pinned message; tapping it
// jumps to that message and moves on to the next pin (if there are several),
// like WhatsApp. Renders nothing when nothing is pinned.
export function PinnedBar({
  pins,
  onJump,
}: {
  pins: PinnedMessage[]
  onJump: (id: number) => void
}) {
  const [index, setIndex] = React.useState(0)

  if (pins.length === 0) {
    return null
  }

  // The list can shrink while this is showing, so the index is wrapped.
  const position = index % pins.length
  const current = pins[position]

  const label =
    current.kind === "image"
      ? "Photo"
      : current.kind === "voice"
        ? "Voice message"
        : (current.body ?? "")

  return (
    <button
      type="button"
      aria-label="Go to pinned message"
      onClick={() => {
        onJump(current.id)
        setIndex((value) => (value + 1) % pins.length)
      }}
      className="flex w-full shrink-0 items-center gap-3 border-b bg-card px-4 py-2 text-left text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <IconPin className="size-4 shrink-0 text-primary" aria-hidden="true" />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {pins.length > 1
            ? `Pinned message ${position + 1} of ${pins.length}`
            : "Pinned message"}
        </span>
        <span className="truncate text-muted-foreground">{label}</span>
      </span>
    </button>
  )
}
