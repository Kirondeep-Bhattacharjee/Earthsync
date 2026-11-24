import * as React from "react"
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"

// Save as src/components/chat/voice-player.tsx

const BARS = 48
const SEEK_STEP_SECONDS = 5

// Only one voice note plays at a time: starting one pauses the other.
let activeAudio: HTMLAudioElement | null = null

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

// Bar heights from 0 to 1. The server sends about 48 peaks (0 to 255). Old
// notes without a waveform get a stable fake pattern seeded by the message id,
// so they still look like a voice note and do not change between renders.
function barHeights(waveform: number[] | null, seed: number): number[] {
  if (waveform && waveform.length > 0) {
    const max = Math.max(...waveform)

    // All zeros: the recording is silent.
    if (max === 0) {
      return Array.from({ length: BARS }, () => 0.1)
    }

    return Array.from({ length: BARS }, (_, index) => {
      const source = Math.min(
        waveform.length - 1,
        Math.floor((index * waveform.length) / BARS)
      )

      return Math.max(0.12, waveform[source] / max)
    })
  }

  let state = (seed * 9301 + 49297) % 233280 || 1

  return Array.from({ length: BARS }, () => {
    state = (state * 9301 + 49297) % 233280

    return 0.25 + (state / 233280) * 0.65
  })
}

type VoicePlayerProps = {
  src: string
  durationSeconds: number | null
  waveform: number[] | null
  seed: number
  // Fires when the signed URL has expired (see refreshMedia in chat-thread).
  onError: () => void
}

export function VoicePlayer({
  src,
  durationSeconds,
  waveform,
  seed,
  onError,
}: VoicePlayerProps) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = React.useState(false)
  const [current, setCurrent] = React.useState(0)
  const [loadedDuration, setLoadedDuration] = React.useState<number | null>(null)

  const heights = React.useMemo(
    () => barHeights(waveform, seed),
    [waveform, seed]
  )

  const total =
    loadedDuration && Number.isFinite(loadedDuration)
      ? loadedDuration
      : (durationSeconds ?? 0)
  const progress = total > 0 ? Math.min(1, current / total) : 0

  // Smooth progress while playing (timeupdate alone only fires a few times a second).
  React.useEffect(() => {
    if (!playing) {
      return
    }

    let frame = 0

    function tick() {
      const audio = audioRef.current

      if (audio) {
        setCurrent(audio.currentTime)
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [playing])

  // Leaving the thread (or deleting the message) stops the sound.
  React.useEffect(() => {
    const audio = audioRef.current

    return () => {
      audio?.pause()

      if (activeAudio === audio) {
        activeAudio = null
      }
    }
  }, [])

  function toggle() {
    const audio = audioRef.current

    if (!audio) {
      return
    }

    if (!audio.paused) {
      audio.pause()
      return
    }

    if (activeAudio && activeAudio !== audio) {
      activeAudio.pause()
    }

    activeAudio = audio
    audio.play().catch(() => setPlaying(false))
  }

  function seekTo(fraction: number) {
    const audio = audioRef.current

    if (!audio || total <= 0) {
      return
    }

    const time = Math.min(1, Math.max(0, fraction)) * total

    audio.currentTime = time
    setCurrent(time)
  }

  function seekFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()

    if (rect.width > 0) {
      seekTo((event.clientX - rect.left) / rect.width)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (total <= 0) {
      return
    }

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()

      const delta = event.key === "ArrowRight" ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS

      seekTo((current + delta) / total)
    }
  }

  const label = total > 0 ? `Voice message, ${formatDuration(total)}` : "Voice message"

  return (
    <div className="flex w-60 max-w-full items-center gap-2 px-1 py-0.5">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onError={onError}
        onLoadedMetadata={(event) => setLoadedDuration(event.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={(event) => {
          event.currentTarget.currentTime = 0
          setPlaying(false)
          setCurrent(0)
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-current/15 outline-none transition-colors hover:bg-current/25 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {playing ? (
          <IconPlayerPauseFilled className="size-4" aria-hidden="true" />
        ) : (
          <IconPlayerPlayFilled className="size-4" aria-hidden="true" />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatDuration(current)} of ${formatDuration(total)}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            seekFromPointer(event)
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) {
              seekFromPointer(event)
            }
          }}
          onKeyDown={onKeyDown}
          className="flex h-7 w-full cursor-pointer touch-none items-center gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {heights.map((height, index) => (
            <span
              key={index}
              aria-hidden="true"
              style={{ height: `${Math.round(height * 100)}%` }}
              className={cn(
                "w-0 flex-1 rounded-full bg-current",
                index < Math.round(progress * BARS) ? "opacity-100" : "opacity-35"
              )}
            />
          ))}
        </div>

        <span className="text-[11px] leading-none tabular-nums opacity-80">
          {formatDuration(playing || current > 0 ? current : total)}
        </span>
      </div>
    </div>
  )
}