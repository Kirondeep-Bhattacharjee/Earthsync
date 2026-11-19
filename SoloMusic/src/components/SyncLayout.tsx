import { Suspense, useEffect, useRef } from "react"
import { Outlet, useLocation } from "react-router-dom"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { ModeToggle } from "@/components/mode-toggle"
import { PageSkeleton } from "@/components/skeletons/page-skeleton"
import { BottomNav } from "@/components/bottom-nav"

export function SyncLayout() {
  const mainRef = useRef<HTMLElement>(null)
  const { pathname } = useLocation()

  // The page now scrolls inside <main>, not the window, and <main> stays
  // mounted between routes. Without this, a new page can open already scrolled.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [pathname])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-dvh overflow-hidden">
        <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 px-4">
          <SidebarTrigger />
          <div className="ml-auto">
            <ModeToggle />
          </div>
        </header>
        <main
          ref={mainRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6 has-[[data-fullbleed]]:overflow-hidden has-[[data-fullbleed]]:p-0"
        >
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}