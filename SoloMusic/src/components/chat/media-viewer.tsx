import * as React from "react"
import { IconX } from "@tabler/icons-react"

// Save as src/components/chat/media-viewer.tsx
//
// Full-screen photo viewer on the native <dialog> element: it traps focus,
// closes on Escape, and returns focus to the thumbnail that opened it. A click
// on the dark area or the X button closes it.

type MediaViewerProps = {
  src: string
  alt?: string
  onClose: () => void
  // Fires when the signed URL has expired (see refreshMedia in chat-thread).
  onError?: () => void
}

export function MediaViewer({
  src,
  alt = "Photo",
  onClose,
  onError,
}: MediaViewerProps) {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null)

  React.useEffect(() => {
    const dialog = dialogRef.current

    if (dialog && !dialog.open) {
      dialog.showModal()
    }

    return () => {
      if (dialog?.open) {
        dialog.close()
      }
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      aria-label="Photo viewer"
      // Fires for Escape and for close(), so there is one way out.
      onClose={onClose}
      onClick={(event) => {
        // Only a click on the dark area itself, not on the photo.
        if (event.target === event.currentTarget) {
          dialogRef.current?.close()
        }
      }}
      className="m-0 h-dvh max-h-none w-dvw max-w-none items-center justify-center border-0 bg-transparent p-0 text-white open:flex backdrop:bg-black/90"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => dialogRef.current?.close()}
        className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] flex size-10 items-center justify-center rounded-full bg-white/10 text-white outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white"
      >
        <IconX className="size-5" aria-hidden="true" />
      </button>

      <img
        src={src}
        alt={alt}
        onError={onError}
        className="max-h-[90dvh] max-w-[95vw] select-none rounded-md object-contain"
      />
    </dialog>
  )
}