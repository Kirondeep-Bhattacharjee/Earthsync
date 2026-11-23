import * as React from "react"

// Matches VOICE_MAX_SECONDS on the server. The recorder stops itself here.
export const VOICE_MAX_SECONDS = 60
// The server refuses anything under a second.
const VOICE_MIN_SECONDS = 1

// Tried in order. Chrome and Firefox record WebM or Ogg, Safari records MP4.
// All of them are accepted by the server, which converts to .m4a.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/webm",
]

export type RecordedVoice = {
  blob: Blob
  fileName: string
}

export type RecorderState = "idle" | "starting" | "recording"

function pickMimeType(): string | undefined {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type))
}

function fileNameFor(type: string): string {
  if (type.includes("mp4")) {
    return "voice.m4a"
  }

  if (type.includes("ogg")) {
    return "voice.ogg"
  }

  return "voice.webm"
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  )
}

// Records one voice note. `stop()` and the 60 second cap both finish the
// recording and call `onFinished` with the audio; `cancel()` throws it away.
export function useVoiceRecorder(onFinished: (voice: RecordedVoice) => void) {
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"

  const [state, setState] = React.useState<RecorderState>("idle")
  const [elapsed, setElapsed] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const timerRef = React.useRef<number | undefined>(undefined)
  const startedAtRef = React.useRef(0)
  const discardRef = React.useRef(false)
  const busyRef = React.useRef(false)
  const onFinishedRef = React.useRef(onFinished)

  React.useEffect(() => {
    onFinishedRef.current = onFinished
  }, [onFinished])

  // Turns the microphone off (the browser's recording indicator goes away).
  const release = React.useCallback(() => {
    window.clearInterval(timerRef.current)

    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop()
    }

    streamRef.current = null
    recorderRef.current = null
  }, [])

  const start = React.useCallback(async () => {
    if (busyRef.current) {
      return
    }

    busyRef.current = true
    setError(null)
    setState("starting")

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      discardRef.current = false

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        const seconds = (Date.now() - startedAtRef.current) / 1000
        const type = recorder.mimeType || mimeType || "audio/webm"
        const blob = new Blob(chunksRef.current, { type })
        const discard = discardRef.current

        release()
        busyRef.current = false
        setState("idle")
        setElapsed(0)

        if (discard) {
          return
        }

        if (seconds < VOICE_MIN_SECONDS || blob.size === 0) {
          setError("Too short. Hold on a little longer to record.")
          return
        }

        onFinishedRef.current({ blob, fileName: fileNameFor(type) })
      }

      recorder.start()
      startedAtRef.current = Date.now()
      setState("recording")

      timerRef.current = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000)

        setElapsed(Math.min(seconds, VOICE_MAX_SECONDS))

        if (seconds >= VOICE_MAX_SECONDS && recorder.state === "recording") {
          recorder.stop()
        }
      }, 250)
    } catch (caught) {
      release()
      busyRef.current = false
      setState("idle")
      setError(
        isPermissionError(caught)
          ? "Microphone access is blocked. Allow it in your browser settings."
          : "Could not start recording."
      )
    }
  }, [release])

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current

    if (recorder && recorder.state === "recording") {
      recorder.stop()
    }
  }, [])

  const cancel = React.useCallback(() => {
    const recorder = recorderRef.current

    discardRef.current = true

    if (recorder && recorder.state === "recording") {
      recorder.stop()
    } else {
      release()
      busyRef.current = false
      setState("idle")
      setElapsed(0)
    }
  }, [release])

  // Leaving the page must not leave the microphone on.
  React.useEffect(() => {
    return () => {
      discardRef.current = true

      const recorder = recorderRef.current

      if (recorder && recorder.state === "recording") {
        recorder.onstop = null
        recorder.stop()
      }

      release()
    }
  }, [release])

  const clearError = React.useCallback(() => setError(null), [])

  return { supported, state, elapsed, error, clearError, start, stop, cancel }
}
