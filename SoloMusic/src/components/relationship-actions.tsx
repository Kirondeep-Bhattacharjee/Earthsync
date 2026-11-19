import { useState } from "react"
import {
  IconCheck,
  IconUserCheck,
  IconUserMinus,
  IconUserPlus,
  IconX,
} from "@tabler/icons-react"

import { Button } from "@/components/ui/button"

export type Relationship =
  | "self"
  | "friend"
  | "request_sent"
  | "request_received"
  | "none"

type Action = "send" | "cancel" | "accept" | "decline" | "unfriend"

type Props = {
  username: string
  relationship: Relationship
  // Called only after the server confirms, with the new relationship.
  onChange: (next: Relationship) => void
}

const API_URL = import.meta.env.VITE_API_URL ?? ""

const RELATIONSHIPS: Relationship[] = [
  "self",
  "friend",
  "request_sent",
  "request_received",
  "none",
]

// Used only if the response body does not carry a usable relationship.
const FALLBACK_RESULT: Record<Action, Relationship> = {
  send: "request_sent",
  cancel: "none",
  decline: "none",
  accept: "friend",
  unfriend: "none",
}

function buildRequest(action: Action, username: string) {
  const name = encodeURIComponent(username)
  switch (action) {
    case "send":
      return {
        method: "POST",
        path: "/api/friend-requests",
        body: JSON.stringify({ username }),
      }
    case "accept":
      return {
        method: "POST",
        path: `/api/friend-requests/${name}/accept`,
        body: undefined,
      }
    case "cancel":
    case "decline":
      return {
        method: "DELETE",
        path: `/api/friend-requests/${name}`,
        body: undefined,
      }
    case "unfriend":
      return {
        method: "DELETE",
        path: `/api/friends/${name}`,
        body: undefined,
      }
  }
}

export default function RelationshipActions({
  username,
  relationship,
  onChange,
}: Props) {
  const [pending, setPending] = useState<Action | null>(null)
  const [confirmingUnfriend, setConfirmingUnfriend] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: Action) {
    setPending(action)
    setError(null)

    try {
      const { method, path, body } = buildRequest(action, username)
      const res = await fetch(`${API_URL}${path}`, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        if (res.status === 401) {
          setError("Your session expired. Sign in again to continue.")
        } else if (res.status === 429) {
          setError("You have sent too many requests. Try again later.")
        } else if (res.status === 404) {
          setError("Could not find that user. They may have changed their username.")
        } else {
          setError(
            typeof data?.message === "string"
              ? data.message
              : "Could not update this friendship. Try again."
          )
        }
        return
      }

      const fromServer = data?.relationship
      const next: Relationship = RELATIONSHIPS.includes(fromServer)
        ? fromServer
        : FALLBACK_RESULT[action]

      setConfirmingUnfriend(false)
      onChange(next)
    } catch {
      setError("Could not reach the server. Check your connection and try again.")
    } finally {
      setPending(null)
    }
  }

  if (relationship === "self") return null

  const busy = pending !== null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {relationship === "none" && (
          <Button onClick={() => run("send")} disabled={busy}>
            <IconUserPlus className="size-4" />
            {pending === "send" ? "Sending…" : "Add friend"}
          </Button>
        )}

        {relationship === "request_sent" && (
          <Button
            variant="outline"
            onClick={() => run("cancel")}
            disabled={busy}
          >
            <IconX className="size-4" />
            {pending === "cancel" ? "Cancelling…" : "Cancel request"}
          </Button>
        )}

        {relationship === "request_received" && (
          <>
            <Button onClick={() => run("accept")} disabled={busy}>
              <IconCheck className="size-4" />
              {pending === "accept" ? "Accepting…" : "Accept request"}
            </Button>
            <Button
              variant="outline"
              onClick={() => run("decline")}
              disabled={busy}
            >
              <IconX className="size-4" />
              {pending === "decline" ? "Declining…" : "Decline"}
            </Button>
          </>
        )}

        {relationship === "friend" && !confirmingUnfriend && (
          <>
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <IconUserCheck className="size-4" />
              Friends
            </span>
            <Button
              variant="outline"
              onClick={() => setConfirmingUnfriend(true)}
              disabled={busy}
            >
              <IconUserMinus className="size-4" />
              Unfriend
            </Button>
          </>
        )}

        {relationship === "friend" && confirmingUnfriend && (
          <>
            <span className="text-sm text-muted-foreground">
              Remove @{username} from your friends?
            </span>
            <Button
              variant="destructive"
              onClick={() => run("unfriend")}
              disabled={busy}
            >
              {pending === "unfriend" ? "Removing…" : "Yes, unfriend"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmingUnfriend(false)}
              disabled={busy}
            >
              Keep friend
            </Button>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}