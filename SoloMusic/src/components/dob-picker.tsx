import * as React from "react"
import { CalendarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// Local-time formatting on purpose: toISOString() is UTC and can shift the day.
function toDobString(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

type DobPickerProps = {
  id?: string
  name?: string
  invalid?: boolean
}

export function DobPicker({
  id = "date-of-birth",
  name = "dateOfBirth",
  invalid,
}: DobPickerProps) {
  const [date, setDate] = React.useState<Date | undefined>()
  const [open, setOpen] = React.useState(false)

  const today = new Date()
  const eighteenYearsAgo = new Date(
    today.getFullYear() - 18,
    today.getMonth(),
    today.getDate()
  )

  return (
    <>
      {/* Keeps the existing FormData / dobSchema flow unchanged */}
      <input type="hidden" name={name} value={date ? toDobString(date) : ""} />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              aria-invalid={invalid}
              className="w-full justify-start font-normal"
            />
          }
        >
          <CalendarIcon />
          {date ? date.toLocaleDateString() : "Select date of birth"}
        </PopoverTrigger>

        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={(next) => {
              setDate(next)
              setOpen(false)
            }}
            captionLayout="dropdown"
            defaultMonth={date ?? eighteenYearsAgo}
            startMonth={new Date(1900, 0)}
            endMonth={today}
            disabled={{ after: today }}
          />
        </PopoverContent>
      </Popover>
    </>
  )
}