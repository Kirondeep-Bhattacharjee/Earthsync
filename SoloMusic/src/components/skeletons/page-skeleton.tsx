import { Skeleton } from "@/components/ui/skeleton"

// Generic fallback for any page that has no skeleton of its own. It is the
// Suspense fallback inside SyncLayout's <main>, which already pads the page,
// so this adds no padding of its own. max-w-5xl matches the profile page.
export function PageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-1/3 max-w-xs" />
        <Skeleton className="hidden h-9 w-28 sm:block" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-28 w-full rounded-xl" />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>

      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  )
}