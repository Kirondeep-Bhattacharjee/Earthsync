import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { IconLock } from "@tabler/icons-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"

// Shape returned by the friend request and friends lists (never email or bio).
export type Person = {
  username: string
  visibility: "public" | "private"
  profilePictureUrl: string | null
  since: string
}

export function formatDay(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso))
}

type Props = {
  person: Person
  // Small line under the username, e.g. "Sent 9 Nov 2026".
  detail: string
  // Action buttons shown on the right.
  children?: ReactNode
}

export default function PersonRow({ person, detail, children }: Props) {
  return (
    <li className="flex items-center gap-3 py-3">
      <Link
        to={`/u/${person.username}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar>
          {person.profilePictureUrl && (
            <AvatarImage src={person.profilePictureUrl} alt="" />
          )}
          <AvatarFallback>
            {person.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">@{person.username}</span>
            {person.visibility === "private" && (
              <Badge variant="secondary">
                <IconLock className="size-3" />
                Private
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
      </Link>
      {children && <div className="flex shrink-0 gap-2">{children}</div>}
    </li>
  )
}