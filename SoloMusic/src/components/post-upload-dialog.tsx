import { useEffect, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { IconPhotoPlus } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import {
  POST_CAPTION_MAX,
  POST_IMAGE_MAX_BYTES,
  POST_VIDEO_MAX_BYTES,
  POST_VIDEO_MAX_SECONDS,
  type Post,
} from "@/lib/post-types"

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

const ACCEPT = "image/*,video/mp4,video/quicktime,video/webm"

// Same tolerance as the backend: a "30 second" phone clip is often 30.03.
const DURATION_TOLERANCE_SECONDS = 0.5

type Props = {
  onClose: () => void
  onCreated: (post: Post) => void
}

function PostUploadDialog({ onClose, onCreated }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [caption, setCaption] = useState("")
  const [error, setError] = useState<string | null>(null)
  // null = not uploading. 100 means the file arrived and the server is encoding.
  const [progress, setProgress] = useState<number | null>(null)

  const isUploading = progress !== null
  const isVideo = file?.type.startsWith("video/") ?? false

  // Free the temporary preview URL when it is replaced or the dialog closes.
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  // Closing the dialog while a request is running cancels it.
  useEffect(() => {
    return () => xhrRef.current?.abort()
  }, [])

  function clearFile() {
    setFile(null)
    setPreviewUrl(null)
  }

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]

    // Lets the person pick the same file again after an error.
    event.target.value = ""

    if (!selected) {
      return
    }

    const selectedIsImage = selected.type.startsWith("image/")
    const selectedIsVideo = selected.type.startsWith("video/")

    if (!selectedIsImage && !selectedIsVideo) {
      setError("Choose a photo or a video.")
      return
    }

    if (selectedIsImage && selected.size > POST_IMAGE_MAX_BYTES) {
      setError("Photos must be 10 MB or smaller.")
      return
    }

    if (selected.size > POST_VIDEO_MAX_BYTES) {
      setError("Videos must be 100 MB or smaller.")
      return
    }

    setError(null)
    setFile(selected)
    setPreviewUrl(URL.createObjectURL(selected))
  }

  // Best-effort length check so a long video is refused before uploading it.
  // The server checks again; this only saves the wait.
  function handleVideoMetadata(duration: number) {
    if (
      Number.isFinite(duration) &&
      duration > POST_VIDEO_MAX_SECONDS + DURATION_TOLERANCE_SECONDS
    ) {
      setError(`Videos can be up to ${POST_VIDEO_MAX_SECONDS} seconds.`)
      clearFile()
    }
  }

  // XMLHttpRequest instead of fetch, because fetch cannot report upload progress.
  function handleSubmit() {
    if (!file || isUploading) {
      return
    }

    setError(null)
    setProgress(0)

    const formData = new FormData()
    formData.append("media", file)

    const trimmed = caption.trim()

    if (trimmed) {
      formData.append("caption", trimmed)
    }

    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr

    xhr.open("POST", `${API_URL}/api/posts`)
    xhr.withCredentials = true

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      xhrRef.current = null

      let data: { message?: string; post?: Post } = {}

      try {
        data = JSON.parse(xhr.responseText) as typeof data
      } catch {
        // Not JSON; fall through to the generic message.
      }

      if (xhr.status === 201 && data.post) {
        onCreated(data.post)
        onClose()
        return
      }

      setProgress(null)
      setError(
        xhr.status === 401
          ? "Your session has expired. Sign in again to post."
          : (data.message ?? "Could not upload your post. Try again.")
      )
    }

    xhr.onerror = () => {
      xhrRef.current = null
      setProgress(null)
      setError(
        "Could not reach the server. Check your connection and try again."
      )
    }

    xhr.send(formData)
  }

  function handleCancelUpload() {
    xhrRef.current?.abort()
    xhrRef.current = null
    setProgress(null)
  }

  const submitLabel = !isUploading
    ? "Post"
    : progress === 100
      ? "Processing…"
      : `Uploading ${progress}%`

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Stay open while uploading; use "Cancel upload" instead.
        if (!next && !isUploading) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New post</DialogTitle>
          <DialogDescription>
            Share a photo or a video of up to {POST_VIDEO_MAX_SECONDS} seconds.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={handleFileSelected}
        />

        {previewUrl && file ? (
          <div className="flex flex-col items-start gap-2">
            <div className="w-full overflow-hidden rounded-md bg-muted">
              {isVideo ? (
                <video
                  src={previewUrl}
                  muted
                  controls
                  playsInline
                  className="max-h-72 w-full object-contain"
                  onLoadedMetadata={(event) =>
                    handleVideoMetadata(event.currentTarget.duration)
                  }
                />
              ) : (
                <img
                  src={previewUrl}
                  alt="Preview of the photo you chose"
                  className="max-h-72 w-full object-contain"
                />
              )}
            </div>
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose a different file
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <IconPhotoPlus className="size-8" />
            <span className="text-sm font-medium">Choose a photo or video</span>
          </button>
        )}

        <div className="flex flex-col gap-1.5">
          <Textarea
            rows={3}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            maxLength={POST_CAPTION_MAX}
            placeholder="Add a caption (optional)"
            aria-label="Caption"
            disabled={isUploading}
          />
          <span className="ml-auto text-sm text-muted-foreground">
            {caption.length}/{POST_CAPTION_MAX}
          </span>
        </div>

        {isUploading && (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? 0}
            aria-label="Upload progress"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          {isUploading ? (
            <Button type="button" variant="outline" onClick={handleCancelUpload}>
              Cancel upload
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="button" disabled={!file || isUploading} onClick={handleSubmit}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PostUploadDialog
