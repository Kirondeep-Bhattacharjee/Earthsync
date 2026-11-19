import { useState } from "react"
import { IconLock, IconWorld } from "@tabler/icons-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export type Visibility = "public" | "private"

type VisibilityToggleProps = {
  value: Visibility
  // Called only after the server confirmed the change.
  onSaved: (value: Visibility) => void
}

// Leave VITE_API_URL empty if you use a Vite dev proxy for /api.
const API_URL = import.meta.env.VITE_API_URL ?? ""

const COPY: Record<Visibility, { title: string; description: string }> = {
  private: {
    title: "Your profile is private",
    description:
      "People can find you in search, but only friends can see your bio.",
  },
  public: {
    title: "Your profile is public",
    description: "Anyone can find you in search and see your bio.",
  },
}

// Saves immediately (no Save button). The switch and the text update right
// away, and go back to the saved value if the server rejects the change.
function VisibilityToggle({ value, onSaved }: VisibilityToggleProps) {
  const [pending, setPending] = useState<Visibility | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSaving = pending !== null
  const shown: Visibility = pending ?? value
  const Icon = shown === "private" ? IconLock : IconWorld

  async function handleChange(checked: boolean) {
    const next: Visibility = checked ? "private" : "public"

    setPending(next)
    setJustSaved(false)
    setError(null)

    try {
      const response = await fetch(`${API_URL}/api/profile`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      })

      if (response.status === 401) {
        setError("Your session has expired. Sign in again to change this.")
        return
      }

      if (!response.ok) {
        setError("Could not update your profile visibility. Try again.")
        return
      }

      onSaved(next)
      setJustSaved(true)
    } catch {
      setError(
        "Could not reach the server. Check your connection and try again."
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="profile-visibility" className="flex items-center gap-2">
            <Icon className="size-4 text-muted-foreground" />
            {COPY[shown].title}
          </Label>
          <p className="text-sm text-muted-foreground">
            {COPY[shown].description}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <Switch
            id="profile-visibility"
            aria-label="Private profile"
            checked={shown === "private"}
            disabled={isSaving}
            onCheckedChange={(checked) => void handleChange(checked)}
          />
          <span className="text-xs text-muted-foreground" role="status">
            {isSaving ? "Saving…" : justSaved ? "Saved" : ""}
          </span>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default VisibilityToggle