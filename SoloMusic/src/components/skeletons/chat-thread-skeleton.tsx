import { Skeleton } from "@/components/ui/skeleton"

// Mirrors Pages/chat-thread.tsx: header, a few bubbles, composer.
export function ChatThreadSkeleton() {
  return (
    <div data-fullbleed className="flex h-full min-h-0 w-full flex-col bg-background p-4">
      <div className="flex items-center gap-3 border-b pb-3">
        <Skeleton className="size-8 shrink-0 rounded-md" />
        <Skeleton className="size-9 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>

      <div className="flex flex-col gap-4 py-4">
        <Skeleton className="h-10 w-2/3 rounded-2xl" />
        <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
        <Skeleton className="h-16 w-3/5 rounded-2xl" />
        <Skeleton className="h-10 w-2/5 self-end rounded-2xl" />
      </div>

      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  )
}