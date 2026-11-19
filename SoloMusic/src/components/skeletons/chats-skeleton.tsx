import { Skeleton } from "@/components/ui/skeleton"

type ChatsSkeletonProps = {
  rows?: number
}

// Mirrors the list on Pages/chats.tsx: avatar, name and preview, time.
export function ChatsSkeleton({ rows = 5 }: ChatsSkeletonProps) {
  return (
    <div
      role="status"
      aria-label="Loading chats"
      className="divide-y rounded-xl border bg-card"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 p-4">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-3/4 max-w-xs" />
          </div>
          <Skeleton className="h-3 w-10 shrink-0 self-start" />
        </div>
      ))}
    </div>
  )
}