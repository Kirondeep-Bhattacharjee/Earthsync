import { useEffect } from "react"
import {
  IconCompass,
  IconHome,
  IconMessageCircle,
  IconUser,
  IconUserPlus,
  type Icon,
} from "@tabler/icons-react"
import { Link, useLocation } from "react-router-dom"
import { cn } from "@/lib/utils"

type Tab = { title: string; url: string; icon: Icon; badge?: number }

// Same breakpoint as the shadcn sidebar (it turns into a sheet below 768px),
// so exactly one of the two navigations is visible at any width.
// Friends, Settings, Help and Sign out stay in the sidebar sheet, opened
// with the SidebarTrigger in the SyncLayout header.
const getTabs = (requests: number, unreadChats: number): Tab[] => [
  { title: "Home", url: "/dashboard", icon: IconHome },
  { title: "Connect", url: "/connect", icon: IconCompass },
  { title: "Chats", url: "/chats", icon: IconMessageCircle, badge: unreadChats },
  { title: "Requests", url: "/requests", icon: IconUserPlus, badge: requests },
  { title: "Profile", url: "/profile", icon: IconUser },
]

// A thread (/chats/:username) has its own composer at the bottom of the
// screen, so the bar steps aside there, as in most chat apps.
const THREAD_PATH = /^\/chats\/[^/]+/

const BAR_HEIGHT = "3.5rem"
const MOBILE_QUERY = "(max-width: 767px)"

// Counts come from AppSidebar (which already fetches them), so this adds no
// extra requests. Mounted inside AppSidebar, so SyncLayout stays untouched.
export function BottomNav({
  requests,
  unreadChats,
}: {
  requests: number
  unreadChats: number
}) {
  const { pathname } = useLocation()
  const hidden = THREAD_PATH.test(pathname)

  // The bar is fixed and SyncLayout does not know about it, so keep the end
  // of <main>'s content clear of it with bottom padding. Padding (not a
  // margin) leaves <main>'s own height alone, so pages sized against it do not
  // start to overflow and show a scrollbar. Cleanup restores it: on a thread
  // page, on desktop and on unmount.
  useEffect(() => {
    if (hidden) {
      return
    }

    const main = document.querySelector("main")

    if (!main) {
      return
    }

    const query = window.matchMedia(MOBILE_QUERY)

    function apply() {
      if (!main) {
        return
      }

      main.style.paddingBottom = query.matches
        ? `calc(${BAR_HEIGHT} + 1rem + env(safe-area-inset-bottom, 0px))`
        : ""
    }

    apply()
    query.addEventListener("change", apply)

    return () => {
      query.removeEventListener("change", apply)
      main.style.paddingBottom = ""
    }
  }, [hidden])

  if (hidden) {
    return null
  }

  return (
    // z-40 sits under the sidebar sheet (z-50), so the drawer covers it.
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="flex" style={{ height: BAR_HEIGHT }}>
        {getTabs(requests, unreadChats).map((tab) => {
          const isActive =
            pathname === tab.url || pathname.startsWith(`${tab.url}/`)
          const count = tab.badge ?? 0

          return (
            <li key={tab.url} className="flex-1">
              <Link
                to={tab.url}
                aria-label={count > 0 ? `${tab.title}, ${count} new` : tab.title}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-full items-center justify-center outline-none focus-visible:bg-accent",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}
              >
                <tab.icon className="size-6" stroke={isActive ? 2.25 : 1.75} />
                {count > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-2 left-1/2 ml-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}