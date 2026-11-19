import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Mirrors the layout of Pages/user-profile.tsx so nothing jumps when data arrives.
export function UserProfileSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-2xl"
      role="status"
      aria-label="Loading profile"
    >
      <Card>
        <CardHeader>
          <div className="flex flex-col items-center gap-5 sm:flex-row">
            <Skeleton className="size-28 shrink-0 rounded-full" />
            <div className="flex w-full flex-col items-center gap-2 sm:items-start">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 border-t pt-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    </div>
  )
}