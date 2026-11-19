import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Mirrors the result list on Pages/connect.tsx.
export function UserListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card
      role="status"
      aria-label="Loading results"
      className="gap-0 overflow-hidden py-0"
    >
      <ul className="divide-y">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="flex items-center gap-3 p-4">
            <Skeleton className="size-12 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}