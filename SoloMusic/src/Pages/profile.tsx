import { useCallback, useEffect, useRef, useState } from "react"
import type { ChangeEvent, FormEvent } from "react"
import { useAuth } from "@/lib/auth"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ProfileSkeleton } from "@/components/skeletons/profile-skeleton"
import VisibilityToggle from "@/components/visibility-toggle"
import ProfilePosts from "@/components/profile-posts"
// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

const USERNAME_MAX = 30
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/ // keep in sync with the backend rule
const BIO_MAX = 500
const AVATAR_MAX_BYTES = 5 * 1024 * 1024 // keep in sync with the backend limit
const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif"

type ProfileData = {
  username: string
  bio: string | null
  profilePictureUrl: string | null
  visibility: "public" | "private"
}

type FieldErrors = Partial<Record<"username" | "bio", string>>

type LoadState = "loading" | "ready" | "unauthenticated" | "error"

function getInitials(label: string): string {
  const parts = label.trim().split(/[\s_]+/).filter(Boolean)
  const first = parts[0]?.[0] ?? "?"
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : ""

  return (first + second).toUpperCase()
}

function Profile() {
  // refresh() re-reads /auth/me, which is what the sidebar shows.
  const { refresh } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [profile, setProfile] = useState<ProfileData | null>(null)

  const [isEditing, setIsEditing] = useState(false)
  const [usernameDraft, setUsernameDraft] = useState("")
  const [bioDraft, setBioDraft] = useState("")
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isAvatarBusy, setIsAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)

  const loadProfile = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading")

    try {
      const response = await fetch(`${API_URL}/api/profile`, {
        credentials: "include",
        signal,
      })

      if (response.status === 401) {
        setLoadState("unauthenticated")
        return
      }

      if (!response.ok) {
        setLoadState("error")
        return
      }

      const data = (await response.json()) as { profile: ProfileData }

      setProfile(data.profile)
      setLoadState("ready")
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return
      }

      setLoadState("error")
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadProfile(controller.signal)

    return () => controller.abort()
  }, [loadProfile])

  // Free the temporary preview URL when it is replaced or the page closes.
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  async function handleAvatarSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    // Lets the user pick the same file again after an error.
    event.target.value = ""

    if (!file) {
      return
    }

    if (!file.type.startsWith("image/")) {
      setAvatarError("Choose an image file (PNG, JPEG, WebP or GIF).")
      return
    }

    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("Image must be 5 MB or smaller.")
      return
    }

    setAvatarError(null)
    setSavedNotice(false)
    setPreviewUrl(URL.createObjectURL(file))
    setIsAvatarBusy(true)

    try {
      const formData = new FormData()
      formData.append("avatar", file)

      // No Content-Type header: the browser sets it with the multipart boundary.
      const response = await fetch(`${API_URL}/api/profile/avatar`, {
        method: "POST",
        credentials: "include",
        body: formData,
      })

      if (response.status === 401) {
        setLoadState("unauthenticated")
        return
      }

      const data = (await response.json()) as {
        message?: string
        profile?: ProfileData
      }

      if (!response.ok || !data.profile) {
        setAvatarError(data.message ?? "Could not upload your photo. Try again.")
        return
      }

      setProfile(data.profile)
    } catch {
      setAvatarError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setPreviewUrl(null)
      setIsAvatarBusy(false)
    }
  }

  async function handleAvatarRemove() {
    setAvatarError(null)
    setSavedNotice(false)
    setIsAvatarBusy(true)

    try {
      const response = await fetch(`${API_URL}/api/profile/avatar`, {
        method: "DELETE",
        credentials: "include",
      })

      if (response.status === 401) {
        setLoadState("unauthenticated")
        return
      }

      const data = (await response.json()) as {
        message?: string
        profile?: ProfileData
      }

      if (!response.ok || !data.profile) {
        setAvatarError(data.message ?? "Could not remove your photo. Try again.")
        return
      }

      setProfile(data.profile)
    } catch {
      setAvatarError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setIsAvatarBusy(false)
    }
  }

  function startEditing() {
    setUsernameDraft(profile?.username ?? "")
    setBioDraft(profile?.bio ?? "")
    setFieldErrors({})
    setFormError(null)
    setSavedNotice(false)
    setIsEditing(true)
  }

  function cancelEditing() {
    setIsEditing(false)
    setFieldErrors({})
    setFormError(null)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!profile) {
      return
    }

    // The server lowercases too, so compare like with like.
    const nextUsername = usernameDraft.trim().toLowerCase()
    const nextBio = bioDraft.trim()
    const usernameChanged = nextUsername !== profile.username

    const nextErrors: FieldErrors = {}

    if (!USERNAME_PATTERN.test(nextUsername)) {
      nextErrors.username = "Use 3 to 30 letters, numbers or underscores"
    }

    if (nextBio.length > BIO_MAX) {
      nextErrors.bio = `Bio must be at most ${BIO_MAX} characters`
    }

    if (nextErrors.username || nextErrors.bio) {
      setFieldErrors(nextErrors)
      return
    }

    setIsSaving(true)
    setFieldErrors({})
    setFormError(null)

    try {
      const response = await fetch(`${API_URL}/api/profile`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // The server turns an empty bio into null, which clears it. The
        // username is only sent when it changed: renames are rate limited.
        body: JSON.stringify({
          bio: nextBio,
          ...(usernameChanged ? { username: nextUsername } : {}),
        }),
      })

      if (response.status === 401) {
        setLoadState("unauthenticated")
        return
      }

      const data = (await response.json()) as {
        message?: string
        errors?: { field: string; message: string }[]
        profile?: ProfileData
      }

      if (!response.ok) {
        if (data.errors?.length) {
          const serverErrors: FieldErrors = {}

          for (const issue of data.errors) {
            if (issue.field === "username" || issue.field === "bio") {
              serverErrors[issue.field] = issue.message
            }
          }

          setFieldErrors(serverErrors)
        }

        setFormError(data.message ?? "Could not save your changes. Try again.")
        return
      }

      if (data.profile) {
        setProfile(data.profile)
      }

      setIsEditing(false)
      setSavedNotice(true)

      // Update the sidebar without a page reload.
      if (usernameChanged) {
        await refresh()
      }
    } catch {
      setFormError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setIsSaving(false)
    }
  }

  if (loadState === "loading") {
    return <ProfileSkeleton />
  }

  if (loadState === "unauthenticated") {
    return (
      <p className="text-muted-foreground" role="alert">
        Your session has expired. Sign in again to see your profile.
      </p>
    )
  }

  if (loadState === "error" || !profile) {
    return (
      <div className="flex flex-col items-start gap-3" role="alert">
        <p className="text-muted-foreground">We couldn’t load your profile.</p>
        <Button variant="outline" onClick={() => void loadProfile()}>
          Try again
        </Button>
      </div>
    )
  }

  const username = profile.username
  const hasPicture = Boolean(profile.profilePictureUrl)

  return (
    // One column that fills the space under the layout padding (SyncLayout
    // provides it): the profile header on top, with the avatar beside the
    // details from md up and stacked on phones, then the posts. max-w-5xl keeps
    // it readable on very wide screens; raise or remove it to stretch further.
    // Keep this in step with ProfileSkeleton.
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-6 text-center md:flex-row md:items-start md:gap-10 md:text-left">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <Avatar className="size-28 ring-2 ring-primary ring-offset-4 ring-offset-card md:size-36">
              <AvatarImage
                src={previewUrl ?? profile.profilePictureUrl ?? undefined}
                alt={`${username}’s profile picture`}
                className={isAvatarBusy ? "opacity-60" : undefined}
              />
              <AvatarFallback className="bg-primary text-3xl font-semibold text-primary-foreground md:text-4xl">
                {getInitials(username)}
              </AvatarFallback>
            </Avatar>

            <input
              ref={fileInputRef}
              type="file"
              accept={AVATAR_ACCEPT}
              className="hidden"
              onChange={(event) => void handleAvatarSelected(event)}
            />

            <div className="mt-2 flex items-center">
              <Button
                variant="link"
                size="sm"
                disabled={isAvatarBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {isAvatarBusy
                  ? "Working…"
                  : hasPicture
                    ? "Change photo"
                    : "Add photo"}
              </Button>
              {hasPicture && (
                <Button
                  variant="link"
                  size="sm"
                  className="text-destructive"
                  disabled={isAvatarBusy}
                  onClick={() => void handleAvatarRemove()}
                >
                  Remove
                </Button>
              )}
            </div>

            {avatarError && (
              <p className="max-w-48 text-sm text-destructive" role="alert">
                {avatarError}
              </p>
            )}
          </div>

          <div className="flex w-full min-w-0 flex-1 flex-col gap-5">
            <div className="flex flex-wrap items-center justify-center gap-3 md:justify-between">
              <h1 className="min-w-0 text-3xl font-semibold break-words">
                @{username}
              </h1>
              {!isEditing && (
                <Button variant="outline" size="sm" onClick={startEditing}>
                  Edit profile
                </Button>
              )}
            </div>

            {savedNotice && !isEditing && (
              <p
                className="rounded-md bg-muted px-3 py-2 text-sm font-medium"
                role="status"
              >
                Profile saved.
              </p>
            )}

            {isEditing ? (
              <form
                className="flex flex-col gap-5 text-left"
                onSubmit={handleSave}
                noValidate
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    value={usernameDraft}
                    onChange={(e) =>
                      setUsernameDraft(e.target.value.toLowerCase())
                    }
                    maxLength={USERNAME_MAX}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={Boolean(fieldErrors.username)}
                    aria-describedby="username-help"
                  />
                  <p
                    id="username-help"
                    className="text-sm text-muted-foreground"
                  >
                    People find you by this name. Changing it breaks old links
                    to your profile, and you can change it up to 5 times an
                    hour.
                  </p>
                  <div className="flex min-h-5 justify-between gap-3 text-sm">
                    <span className="text-destructive" role="alert">
                      {fieldErrors.username}
                    </span>
                    <span className="ml-auto text-muted-foreground">
                      {usernameDraft.length}/{USERNAME_MAX}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="bio">Bio</Label>
                  <Textarea
                    id="bio"
                    rows={5}
                    value={bioDraft}
                    onChange={(e) => setBioDraft(e.target.value)}
                    placeholder="Tell people a little about yourself"
                    aria-invalid={Boolean(fieldErrors.bio)}
                  />
                  <div className="flex min-h-5 justify-between gap-3 text-sm">
                    <span className="text-destructive" role="alert">
                      {fieldErrors.bio}
                    </span>
                    <span
                      className={
                        bioDraft.length > BIO_MAX
                          ? "ml-auto font-medium text-destructive"
                          : "ml-auto text-muted-foreground"
                      }
                    >
                      {bioDraft.length}/{BIO_MAX}
                    </span>
                  </div>
                </div>

                {formError && (
                  <p className="text-sm text-destructive" role="alert">
                    {formError}
                  </p>
                )}

                <div className="flex flex-wrap gap-3">
                  <Button type="submit" disabled={isSaving}>
                    {isSaving ? "Saving…" : "Save changes"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={cancelEditing}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-5">
                {profile.bio ? (
                  <p className="mx-auto max-w-prose whitespace-pre-wrap break-words md:mx-0">
                    {profile.bio}
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Add a bio so people know who you are.
                  </p>
                )}

                <div className="border-t pt-5 text-left">
                  <VisibilityToggle
                    value={profile.visibility}
                    onSaved={(visibility) =>
                      setProfile((current) =>
                        current ? { ...current, visibility } : current
                      )
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <ProfilePosts username={username} isOwner canView />
    </div>
  )
}

export default Profile