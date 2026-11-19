import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import PersonRow, { formatDay, type Person } from "@/components/person-row"
import { PeopleListSkeleton } from "@/components/skeletons/people-list-skeleton"

const API_URL = import.meta.env.VITE_API_URL ?? ""

type LoadState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }
  | { status: "ready"; friends: Person[] }

function Shell({
  description,
  children,
}: {
  description: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Friends</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  )
}

export default function Friends() {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  // The friend the unfriend dialog is open for.
  const [target, setTarget] = useState<Person | null>(null)
  const [removing, setRemoving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" })

    try {
      const res = await fetch(`${API_URL}/api/friends`, {
        credentials: "include",
        signal,
      })

      if (res.status === 401) {
        setState({ status: "unauthenticated" })
        return
      }

      if (!res.ok) throw new Error("Request failed")

      const data = await res.json()
      setState({ status: "ready", friends: data.friends })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setState({
        status: "error",
        message:
          "Could not load your friends. Check your connection and try again.",
      })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function unfriend() {
    if (!target) return

    const { username } = target
    setRemoving(true)
    setActionError(null)

    try {
      const res = await fetch(
        `${API_URL}/api/friends/${encodeURIComponent(username)}`,
        { method: "DELETE", credentials: "include" }
      )

      if (res.status === 401) {
        setState({ status: "unauthenticated" })
        return
      }

      // A 404 means you are already not friends, so the row should go anyway.
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null)
        setActionError(
          typeof data?.message === "string"
            ? data.message
            : "Could not remove this friend. Try again."
        )
        return
      }

      setState((current) =>
        current.status !== "ready"
          ? current
          : {
              ...current,
              friends: current.friends.filter((p) => p.username !== username),
            }
      )
    } catch {
      setActionError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setRemoving(false)
      setTarget(null)
    }
  }

  if (state.status === "loading") {
    return (
      <Shell description="People you are connected with.">
        <Card>
          <CardContent>
            <PeopleListSkeleton />
          </CardContent>
        </Card>
      </Shell>
    )
  }

  if (state.status === "unauthenticated") {
    return (
      <Shell description="People you are connected with.">
        <p className="text-sm text-muted-foreground">
          Your session expired. Sign in again to see your friends.
        </p>
      </Shell>
    )
  }

  if (state.status === "error") {
    return (
      <Shell description="People you are connected with.">
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </Shell>
    )
  }

  const count = state.friends.length

  return (
    <Shell
      description={count === 1 ? "1 friend" : `${count} friends`}
    >
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      <Card>
        <CardContent>
          {count === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                You have no friends yet. Search for people to send a request.
              </p>
              <Link
                to="/connect"
                className={buttonVariants({ variant: "outline" })}
              >
                Find people
              </Link>
            </div>
          ) : (
            <ul className="divide-y">
              {state.friends.map((person) => (
                <PersonRow
                  key={person.username}
                  person={person}
                  detail={`Friends since ${formatDay(person.since)}`}
                >
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/chats/${encodeURIComponent(person.username)}`}
                      className={buttonVariants({ size: "sm" })}
                    >
                      Message
                    </Link>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setTarget(person)}
                    >
                      Unfriend
                    </Button>
                  </div>
                </PersonRow>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unfriend @{target?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              You will stop being friends. Your chat history is kept, and you
              can send a new friend request later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Keep friend</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(event) => {
                // Keep the dialog open until the request finishes.
                event.preventDefault()
                void unfriend()
              }}
            >
              {removing ? "Removing…" : "Unfriend"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  )
}