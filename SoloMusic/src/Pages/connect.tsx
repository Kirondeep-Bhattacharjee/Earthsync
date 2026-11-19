import { useCallback, useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { IconLock, IconMessage, IconSearch } from "@tabler/icons-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import RelationshipActions, {
  type Relationship,
} from "@/components/relationship-actions"
import { UserListSkeleton } from "@/components/skeletons/user-list-skeleton"
import { notifyRequestsChanged } from "@/lib/use-request-count"

const API_URL = import.meta.env.VITE_API_URL ?? ""
const DEBOUNCE_MS = 300

type SearchUser = {
  username: string
  visibility: "public" | "private"
  profilePictureUrl: string | null
  relationship: Relationship
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }
  | { status: "ready"; users: SearchUser[] }

// The server ignores a leading "@", so the client does too.
function normalize(value: string) {
  return value.trim().replace(/^@/, "")
}

function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase()
}

export default function Connect() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "")
  const [term, setTerm] = useState(() => normalize(query))
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<LoadState>({ status: "idle" })

  // Debounce typing, and keep the term in the URL so Back restores the search.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = normalize(query)
      setTerm(next)
      setSearchParams(next ? { q: next } : {}, { replace: true })
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [query, setSearchParams])

  const search = useCallback(async (q: string, signal: AbortSignal) => {
    setState({ status: "loading" })

    try {
      const res = await fetch(
        `${API_URL}/api/users/search?q=${encodeURIComponent(q)}`,
        { credentials: "include", signal }
      )

      if (res.status === 401) {
        setState({ status: "unauthenticated" })
        return
      }

      if (res.status === 429) {
        setState({
          status: "error",
          message: "Could not search: too many searches. Wait a minute and try again.",
        })
        return
      }

      if (!res.ok) {
        setState({
          status: "error",
          message: "Could not search right now. Try again in a moment.",
        })
        return
      }

      const data = (await res.json()) as { users: SearchUser[] }
      setState({ status: "ready", users: data.users })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return
      }

      setState({
        status: "error",
        message: "Could not reach the server. Check your connection and try again.",
      })
    }
  }, [])

  useEffect(() => {
    if (term === "") {
      setState({ status: "idle" })
      return
    }

    const controller = new AbortController()
    void search(term, controller.signal)

    return () => controller.abort()
  }, [term, attempt, search])

  // Updates one row in place after a friend action, without searching again.
  function handleRelationshipChange(username: string, next: Relationship) {
    setState((current) =>
      current.status !== "ready"
        ? current
        : {
            ...current,
            users: current.users.map((user) =>
              user.username === username
                ? { ...user, relationship: next }
                : user
            ),
          }
    )
    notifyRequestsChanged()
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect</h1>
        <p className="text-sm text-muted-foreground">
          Find people by username and send them a friend request.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="user-search" className="sr-only">
          Search by username
        </Label>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="user-search"
            type="search"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={31}
            placeholder="Search by username"
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {state.status === "idle" ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Type a username to find people.
        </p>
      ) : null}

      {state.status === "loading" ? <UserListSkeleton /> : null}

      {state.status === "unauthenticated" ? (
        <p className="py-10 text-center text-sm text-destructive">
          Your session has expired. Sign in again to search.
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="space-y-3 py-10 text-center">
          <p className="text-sm text-destructive">{state.message}</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : null}

      {state.status === "ready" && state.users.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No one matches “{term}”. Check the spelling or try fewer letters.
        </p>
      ) : null}

      {state.status === "ready" && state.users.length > 0 ? (
        <Card className="gap-0 overflow-hidden py-0">
          <ul className="divide-y">
            {state.users.map((user) => (
              // The profile link and the action buttons are siblings, because
              // buttons cannot sit inside a link.
              <li
                key={user.username}
                className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-muted/50"
              >
                <Link
                  to={`/u/${user.username}`}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <Avatar className="size-12">
                    <AvatarImage
                      src={user.profilePictureUrl ?? undefined}
                      alt=""
                    />
                    <AvatarFallback>
                      {getInitials(user.username)}
                    </AvatarFallback>
                  </Avatar>
                  <p className="min-w-0 truncate font-medium">
                    @{user.username}
                  </p>
                  {user.visibility === "private" ? (
                    <Badge variant="secondary" className="gap-1">
                      <IconLock className="size-3" />
                      Private
                    </Badge>
                  ) : null}
                </Link>

                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/chats/${user.username}`}
                    className={buttonVariants({ variant: "outline" })}
                  >
                    <IconMessage aria-hidden="true" />
                    Message
                  </Link>

                  <RelationshipActions
                    username={user.username}
                    relationship={user.relationship}
                    onChange={(next) =>
                      handleRelationshipChange(user.username, next)
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}