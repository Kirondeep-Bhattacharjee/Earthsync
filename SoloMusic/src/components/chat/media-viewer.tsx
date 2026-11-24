import { IconX } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

// Save as src/components/chat/media-viewer.tsx
//
// Full-screen photo viewer on the shadcn Dialog (Base UI). The dialog handles
// focus trapping, Escape, focus return and scroll lock. A click on the dark
// area or the X button closes it. This replaces the native <dialog> version,
// whose effect cleanup closed itself again under React StrictMode.

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
  return (
    // The parent only mounts the viewer while a photo is open, so it is
    // always open here; closing tells the parent to unmount it.
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      {/* The content fills the screen and doubles as the dark backdrop. */}
      <DialogContent
        showCloseButton={false}
        onClick={(event) => {
          // Only a click on the dark area itself, not on the photo.
          if (event.target === event.currentTarget) {
            onClose()
          }
        }}
        className="top-0 left-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 place-items-center gap-0 rounded-none bg-black/90 p-0 text-white ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Photo viewer</DialogTitle>
        <DialogDescription className="sr-only">
          Full-size photo from this chat. Press Escape to close.
        </DialogDescription>

        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close"
              className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] size-10 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
            />
          }
        >
          <IconX className="size-5" aria-hidden="true" />
        </DialogClose>

        <img
          src={src}
          alt={alt}
          onError={onError}
          className="max-h-[90dvh] max-w-[95vw] rounded-md object-contain select-none"
        />
      </DialogContent>
    </Dialog>
  )
}
