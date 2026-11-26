import { useEffect, useState } from "react"
import { IconChecks } from "@tabler/icons-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  SettingsError,
  fetchSettings,
  updateSettings,
} from "@/lib/settings"

// The "Read receipts" switch. It loads and saves the setting itself, so it can
// be dropped into any page. Like VisibilityToggle it saves immediately (no Save
// button): the switch flips at once and goes back if the server says no.
export function ReadReceiptsToggle() {
  // null = still loading.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    fetchSettings(controller.signal)
      .then((settings) => setEnabled(settings.readReceipts))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) {
          return
        }

        setError(
          caught instanceof SettingsError
            ? caught.message
            : "Could not load your settings."
        )
      })

    return () => controller.abort()
  }, [])

  async function handleChange(next: boolean) {
    const previous = enabled

    setEnabled(next)
    setSaving(true)
    setJustSaved(false)
    setError(null)

    try {
      const saved = await updateSettings({ readReceipts: next })

      setEnabled(saved.readReceipts)
      setJustSaved(true)
    } catch (caught) {
      setEnabled(previous)
      setError(
        caught instanceof SettingsError
          ? caught.message
          : "Could not save your settings. Try again."
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="read-receipts" className="flex items-center gap-2">
            <IconChecks className="size-4 text-muted-foreground" />
            Read receipts
          </Label>
          <p className="text-sm text-muted-foreground">
            When this is off, you won&apos;t see when others have read your
            messages, and they won&apos;t see when you have read theirs.
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <Switch
            id="read-receipts"
            aria-label="Read receipts"
            checked={enabled ?? true}
            disabled={enabled === null || saving}
            onCheckedChange={(checked) => void handleChange(checked)}
          />
          <span className="text-xs text-muted-foreground" role="status">
            {saving ? "Saving…" : justSaved ? "Saved" : ""}
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