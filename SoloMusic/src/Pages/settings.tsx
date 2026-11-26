import { ReadReceiptsToggle } from "@/components/read-receipts-toggle"

// Loaded lazily from App.tsx, so it needs a default export. New settings go in
// their own section below.
export default function Settings() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage how Earthsync works for you.
        </p>
      </div>

      <section className="flex flex-col gap-4 border p-4">
        <h2 className="text-sm font-semibold">Privacy</h2>
        <ReadReceiptsToggle />
      </section>
    </div>
  )
}