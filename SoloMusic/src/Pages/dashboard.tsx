import * as React from "react"
import { Link } from "react-router-dom"
import { DEFAULT_LINKS } from "@/components/earthmodel"
import SkyBackground from "@/components/sky-background"
import { cn } from "@/lib/utils"

// What each destination is for, in plain words. Edit these to match your pages.
const DESCRIPTIONS: Record<string, string> = {
  "/chats": "Pick up your conversations.",
  "/friends": "The people you’ve added.",
  "/requests": "Say yes to new friends.",
  "/connect": "Find someone new.",
}

// Most-used first.
const ORDER = ["/chats", "/friends", "/requests", "/connect"]

const ITEMS = ORDER.flatMap((to) => {
  const link = DEFAULT_LINKS.find((l) => l.to === to)
  return link ? [link] : []
})

function Dashboard() {
  // The item being pointed at or focused. The globe turns to its pin.
  const [active, setActive] = React.useState<string | null>(null)

  return (
    <SkyBackground className="min-h-screen w-full">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-8 px-5 py-8 sm:px-6">

        <nav
          aria-label="Main"
          className="grid w-full grid-cols-2 gap-3 md:grid-cols-4"
        >
          {ITEMS.map((item) => {
            const Icon = item.icon

            return (
              <Link
                key={item.to}
                to={item.to}
                onPointerEnter={() => setActive(item.to)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(item.to)}
                onBlur={() => setActive(null)}
                className={cn(
                  "flex flex-col gap-1 rounded-xl border bg-card/60 p-4 outline-none backdrop-blur transition-colors",
                  "hover:border-foreground focus-visible:border-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  active === item.to && "border-foreground"
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  <Icon aria-hidden="true" className="size-5" />
                  {item.label}
                </span>
                <span className="text-sm text-muted-foreground">
                  {DESCRIPTIONS[item.to]}
                </span>
              </Link>
            )
          })}
        </nav>
      </div>
    </SkyBackground>
  )
}

export default Dashboard