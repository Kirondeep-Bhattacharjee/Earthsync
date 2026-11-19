import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Mirrors the layout of the profile page so nothing jumps when data arrives:
// the header card, then the posts grid. No page padding of its own, because
// SyncLayout already pads <main>. Keep it in step with Pages/profile.tsx.
export function ProfileSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      role="status"
      aria-busy="true"
      aria-label="Loading your profile"
    >
      <Card>
        <CardContent className="flex flex-col items-center gap-6 md:flex-row md:items-start md:gap-10">
          <div className="flex shrink-0 flex-col items-center gap-3">
            <Skeleton className="size-28 rounded-full md:size-36" />
            <Skeleton className="h-4 w-24" />
          </div>

          <div className="flex w-full min-w-0 flex-1 flex-col items-center gap-5 md:items-stretch">
            <div className="flex w-full items-center justify-center gap-3 md:justify-between">
              <Skeleton className="h-9 w-48" />
              <Skeleton className="hidden h-8 w-24 md:block" />
            </div>

            <div className="flex w-full flex-col items-center gap-2 md:items-start">
              <Skeleton className="h-4 w-full max-w-md" />
              <Skeleton className="h-4 w-4/5 max-w-sm" />
            </div>

            <div className="w-full border-t pt-5">
              <Skeleton className="h-10 w-full max-w-sm" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-1">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="aspect-square w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}