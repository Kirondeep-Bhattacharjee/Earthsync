import { useCallback, useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import PersonRow, { formatDay, type Person } from "@/components/person-row"
import { PeopleListSkeleton } from "@/components/skeletons/people-list-skeleton"
import { notifyRequestsChanged } from "@/lib/use-request-count"

const API_URL = import.meta.env.VITE_API_URL ?? ""

type LoadState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }
  | { status: "ready"; incoming: Person[]; outgoing: Person[] }

type RequestAction = "accept" | "decline" | "cancel"

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Requests</h1>
        <p className="text-sm text-muted-foreground">
          Accept or decline people who want to be friends, or cancel requests
          you sent.
        </p>
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  )
}

export default function Requests() {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  // Username of the row with a request in flight.
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" })

    try {
      const [incomingRes, outgoingRes] = await Promise.all([
        fetch(`${API_URL}/api/friend-requests/incoming`, {
          credentials: "include",
          signal,
        }),
        fetch(`${API_URL}/api/friend-requests/outgoing`, {
          credentials: "include",
          signal,
        }),
      ])

      if (incomingRes.status === 401 || outgoingRes.status === 401) {
        setState({ status: "unauthenticated" })
        return
      }

      if (!incomingRes.ok || !outgoingRes.ok) {
        throw new Error("Request failed")
      }

      const [incoming, outgoing] = await Promise.all([
        incomingRes.json(),
        outgoingRes.json(),
      ])

      setState({
        status: "ready",
        incoming: incoming.requests,
        outgoing: outgoing.requests,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setState({
        status: "error",
        message:
          "Could not load your requests. Check your connection and try again.",
      })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function act(username: string, action: RequestAction) {
    setBusy(username)
    setActionError(null)

    try {
      const name = encodeURIComponent(username)
      const res = await fetch(
        action === "accept"
          ? `${API_URL}/api/friend-requests/${name}/accept`
          : `${API_URL}/api/friend-requests/${name}`,
        {
          method: action === "accept" ? "POST" : "DELETE",
          credentials: "include",
        }
      )

      if (res.status === 401) {
        setState({ status: "unauthenticated" })
        return
      }

      // A 404 means the request is already gone (withdrawn, or the account is
      // no longer reachable), so the row should disappear either way.
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null)
        setActionError(
          typeof data?.message === "string"
            ? data.message
            : "Could not update this request. Try again."
        )
        return
      }

      setState((current) =>
        current.status !== "ready"
          ? current
          : {
              ...current,
              incoming: current.incoming.filter((p) => p.username !== username),
              outgoing: current.outgoing.filter((p) => p.username !== username),
            }
      )
      notifyRequestsChanged()
    } catch {
      setActionError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setBusy(null)
    }
  }

  if (state.status === "loading") {
    return (
      <Shell>
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
      <Shell>
        <p className="text-sm text-muted-foreground">
          Your session expired. Sign in again to see your requests.
        </p>
      </Shell>
    )
  }

  if (state.status === "error") {
    return (
      <Shell>
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

  return (
    <Shell>
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      <Tabs defaultValue="incoming">
        <TabsList>
          <TabsTrigger value="incoming">
            Incoming ({state.incoming.length})
          </TabsTrigger>
          <TabsTrigger value="outgoing">
            Sent ({state.outgoing.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="incoming">
          <Card>
            <CardContent>
              {state.incoming.length === 0 ? (
                <Empty>No incoming requests right now.</Empty>
              ) : (
                <ul className="divide-y">
                  {state.incoming.map((person) => (
                    <PersonRow
                      key={person.username}
                      person={person}
                      detail={`Sent ${formatDay(person.since)}`}
                    >
                      <Button
                        size="sm"
                        disabled={busy === person.username}
                        onClick={() => void act(person.username, "accept")}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === person.username}
                        onClick={() => void act(person.username, "decline")}
                      >
                        Decline
                      </Button>
                    </PersonRow>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="outgoing">
          <Card>
            <CardContent>
              {state.outgoing.length === 0 ? (
                <Empty>
                  You have no pending requests. Find people on Connect.
                </Empty>
              ) : (
                <ul className="divide-y">
                  {state.outgoing.map((person) => (
                    <PersonRow
                      key={person.username}
                      person={person}
                      detail={`Sent ${formatDay(person.since)}`}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === person.username}
                        onClick={() => void act(person.username, "cancel")}
                      >
                        Cancel request
                      </Button>
                    </PersonRow>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Shell>
  )
}