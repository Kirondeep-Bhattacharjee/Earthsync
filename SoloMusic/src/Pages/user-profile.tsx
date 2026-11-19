import { useCallback, useEffect, useState } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { IconLock } from "@tabler/icons-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import RelationshipActions, {
  type Relationship,
} from "@/components/relationship-actions"
import { UserProfileSkeleton } from "@/components/skeletons/user-profile-skeleton"
import { notifyRequestsChanged } from "@/lib/use-request-count"
import ProfilePosts from "@/components/profile-posts"

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

type UserProfileData = {
  user: {
    username: string
    bio: string | null
    visibility: "public" | "private"
    profilePictureUrl: string | null
  }
  relationship: Relationship
  canViewFullProfile: boolean
}

type LoadState = "loading" | "ready" | "unauthenticated" | "not-found" | "error"

function getInitials(label: string): string {
  const parts = label.trim().split(/[\s_]+/).filter(Boolean)
  const first = parts[0]?.[0] ?? "?"
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : ""

  return (first + second).toUpperCase()
}

function UserProfile() {
  const { username } = useParams<{ username: string }>()

  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [data, setData] = useState<UserProfileData | null>(null)

  const loadProfile = useCallback(
    async (signal?: AbortSignal) => {
      if (!username) {
        setLoadState("not-found")
        return
      }

      setLoadState("loading")

      try {
        const response = await fetch(
          `${API_URL}/api/profile/${encodeURIComponent(username)}`,
          { credentials: "include", signal }
        )

        if (response.status === 401) {
          setLoadState("unauthenticated")
          return
        }

        // The server also returns 404 for blocked users, so the two look the same.
        if (response.status === 404) {
          setLoadState("not-found")
          return
        }

        if (!response.ok) {
          setLoadState("error")
          return
        }

        setData((await response.json()) as UserProfileData)
        setLoadState("ready")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return
        }

        setLoadState("error")
      }
    },
    [username]
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadProfile(controller.signal)

    return () => controller.abort()
  }, [loadProfile])

  // Refetches without the skeleton, so the page doesn't flash after a button
  // press. Needed because becoming or ceasing to be friends changes whether
  // the bio of a private profile is visible. On any failure the current data
  // stays; the relationship has already been updated from the action itself.
  async function refreshProfile() {
    if (!username) return

    try {
      const response = await fetch(
        `${API_URL}/api/profile/${encodeURIComponent(username)}`,
        { credentials: "include" }
      )

      if (!response.ok) return

      const fresh = (await response.json()) as UserProfileData

      // Ignore the result if the person has moved to another profile since.
      if (fresh.user.username !== username) return

      setData(fresh)
    } catch {
      // Keep what is on screen.
    }
  }

  function handleRelationshipChange(next: Relationship) {
    if (!data) return

    const friendshipChanged = next === "friend" || data.relationship === "friend"

    setData({ ...data, relationship: next })

    // Accepting or declining changes the sidebar badge; sending or cancelling
    // does not affect this person's count, but refreshing it is cheap.
    notifyRequestsChanged()

    if (friendshipChanged) void refreshProfile()
  }

  if (loadState === "loading") {
    return <UserProfileSkeleton />
  }

  if (loadState === "unauthenticated") {
    return (
      <p className="text-muted-foreground" role="alert">
        Your session has expired. Sign in again to see this profile.
      </p>
    )
  }

  if (loadState === "not-found") {
    return (
      <div className="flex flex-col items-start gap-1" role="alert">
        <p className="font-medium">User not found</p>
        <p className="text-muted-foreground">
          This account doesn’t exist or isn’t available. Check the username and
          try again.
        </p>
      </div>
    )
  }

  if (loadState === "error" || !data) {
    return (
      <div className="flex flex-col items-start gap-3" role="alert">
        <p className="text-muted-foreground">We couldn’t load this profile.</p>
        <Button variant="outline" onClick={() => void loadProfile()}>
          Try again
        </Button>
      </div>
    )
  }

  const { user, relationship, canViewFullProfile } = data

  // Your own profile is edited on /profile.
  if (relationship === "self") {
    return <Navigate to="/profile" replace />
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:text-left">
            <Avatar className="size-28 shrink-0 ring-2 ring-primary ring-offset-4 ring-offset-card">
              <AvatarImage
                src={user.profilePictureUrl ?? undefined}
                alt={`${user.username}’s profile picture`}
              />
              <AvatarFallback className="bg-primary text-3xl font-semibold text-primary-foreground">
                {getInitials(user.username)}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0">
              <h1 className="text-3xl font-semibold break-words">
                @{user.username}
              </h1>

              {user.visibility === "private" && (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                  <Badge variant="secondary" className="gap-1">
                    <IconLock className="size-3" />
                    Private
                  </Badge>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <RelationshipActions
                  username={user.username}
                  relationship={relationship}
                  onChange={handleRelationshipChange}
                />
                <Link
                  to={`/chats/${encodeURIComponent(user.username)}`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Message
                </Link>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="border-t pt-6">
          {canViewFullProfile ? (
            user.bio ? (
              <p className="max-w-prose whitespace-pre-wrap break-words">
                {user.bio}
              </p>
            ) : (
              <p className="text-muted-foreground">No bio yet.</p>
            )
          ) : (
            <p className="text-muted-foreground">
              This profile is private. You can see their bio once you’re
              friends.
            </p>
          )}
        </CardContent>
      </Card>
      <ProfilePosts
        username={user.username}
        isOwner={false}
        canView={canViewFullProfile}
      />
    </div>
  )
}

export default UserProfile