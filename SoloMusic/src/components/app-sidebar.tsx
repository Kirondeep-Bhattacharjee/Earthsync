import * as React from "react"
import {
  IconCompass,
  IconHelp,
  IconHome,
  IconLogout,
  IconMessageCircle,
  IconSettings,
  IconUser,
  IconUserPlus,
  IconUsers,
  type Icon,
} from "@tabler/icons-react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import SyncLogo from "@/assets/sync-logo.svg"
import EarthLogo from "@/assets/earthsync-mark.svg"
import { useAuth } from "@/lib/auth"
import { useRequestCount } from "@/lib/use-request-count"
import { useUnreadCount } from "@/lib/use-unread-count"
import { BottomNav } from "@/components/bottom-nav"

type NavItem = { title: string; url: string; icon: Icon; badge?: number }

// The Chats badge counts friend threads with unread messages. Messages from
// people who are not friends never show here (they are highlighted in the
// Public tab of Chats).
const getSocial = (requests: number, unreadChats: number): NavItem[] => [
  { title: "Home", url: "/dashboard", icon: IconHome },
  { title: "Chats", url: "/chats", icon: IconMessageCircle, badge: unreadChats },
  { title: "Friends", url: "/friends", icon: IconUsers },
  { title: "Requests", url: "/requests", icon: IconUserPlus, badge: requests },
  { title: "Connect", url: "/connect", icon: IconCompass },
]

const account: NavItem[] = [
  { title: "Profile", url: "/profile", icon: IconUser },
  { title: "Settings", url: "/settings", icon: IconSettings },
]

const support: NavItem[] = [{ title: "Help", url: "/help", icon: IconHelp }]

function NavGroup({
  label,
  items,
  className,
}: {
  label?: string
  items: NavItem[]
  className?: string
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()

  function go(url: string) {
    navigate(url)

    // On a phone the sidebar is a sheet: close it once the page changes.
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  return (
    <SidebarGroup className={className}>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              {/* tooltip: shown on hover only while the sidebar is collapsed to icons. */}
              <SidebarMenuButton
                isActive={
                  pathname === item.url || pathname.startsWith(`${item.url}/`)
                }
                tooltip={item.badge ? `${item.title} (${item.badge})` : item.title}
                onClick={() => go(item.url)}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
              {item.badge ? (
                <>
                  <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                  {/* Collapsed: the badge is hidden, so show a dot on the icon. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-primary group-data-[collapsible=icon]:block"
                  />
                </>
              ) : null}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const requestCount = useRequestCount()
  // AppSidebar renders inside SyncLayout, which sits under ChatSocketProvider.
  const unreadChats = useUnreadCount()

  async function handleSignOut() {
    // Leave the protected area first so ProtectedRoute doesn't redirect to /sign-in
    navigate("/", { replace: true })
    await signOut()
  }

  return (
    // collapsible="icon": on desktop the sidebar shrinks to an icon strip
    // (SidebarTrigger in SyncLayout, the rail on its edge, or Ctrl/Cmd+B).
    <>
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
          <img
            src={EarthLogo}
            alt="EarthSync Logo"
            className="h-10 w-auto cursor-pointer dark:invert group-data-[collapsible=icon]:h-8"
            onClick={() => navigate("/dashboard")}
          />

          {/* The wordmark does not fit in the icon strip. */}
          <img
            src={SyncLogo}
            alt=""
            className="h-12 w-auto cursor-pointer dark:invert group-data-[collapsible=icon]:hidden"
            onClick={() => navigate("/dashboard")}
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <NavGroup label="Social" items={getSocial(requestCount, unreadChats)} />
        <NavGroup label="Account" items={account} />
        <NavGroup items={support} className="mt-auto" />
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
            {user?.username.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 text-xs group-data-[collapsible=icon]:hidden">
            <p className="truncate font-medium">{user?.username}</p>
            <p className="truncate text-muted-foreground">{user?.email}</p>
          </div>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign Out"
              onClick={() => void handleSignOut()}
            >
              <IconLogout />
              <span>Sign Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* A thin strip on the sidebar's edge: click it to collapse or expand. */}
      <SidebarRail />
    </Sidebar>
    <BottomNav requests={requestCount} unreadChats={unreadChats} />
    </>
  )
}