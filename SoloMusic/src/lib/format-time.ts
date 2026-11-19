const DAY_MS = 24 * 60 * 60 * 1000

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
})
const shortWeekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
})
const longWeekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
})

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// Whole calendar days from `date` to `now`. Rounded because a day can be 23 or
// 25 hours long when the clocks change.
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
}

function dateFormat(date: Date, now: Date, month: "short" | "long") {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month,
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date)
}

// Short label for a list row: "14:05", "Yesterday", "Mon", "3 Nov", "3 Nov 2025".
export function formatMessageTime(iso: string, now = new Date()): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return ""
  }

  const days = daysAgo(date, now)

  // Zero or negative means today (a slightly fast clock can put a message in
  // the future), so show the time.
  if (days <= 0) {
    return timeFormat.format(date)
  }

  if (days === 1) {
    return "Yesterday"
  }

  if (days < 7) {
    return shortWeekdayFormat.format(date)
  }

  return dateFormat(date, now, "short")
}

// Label for a day separator in a thread: "Today", "Yesterday", "Monday",
// "3 November", "3 November 2025".
export function formatDayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return ""
  }

  const days = daysAgo(date, now)

  if (days <= 0) {
    return "Today"
  }

  if (days === 1) {
    return "Yesterday"
  }

  if (days < 7) {
    return longWeekdayFormat.format(date)
  }

  return dateFormat(date, now, "long")
}

// True when two timestamps fall on the same calendar day (for day separators).
export function isSameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b))
}

// Short relative label for a comment or activity row: "just now", "5m",
// "3h", "2d", then a localized date. Pass `now` so a caller can refresh it on
// an interval and keep the label current without re-reading the server.
export function formatRelativeTime(iso: string, now = new Date()): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return ""
  }

  const seconds = Math.max(
    0,
    Math.round((now.getTime() - date.getTime()) / 1000)
  )

  if (seconds < 60) {
    return "just now"
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }

  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d`
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date)
}