import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { DobPicker } from "@/components/dob-picker"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { apiFetch, ApiError } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { dobSchema, isAdult } from "@/lib/dob"

type OnboardingInfo = {
  required: boolean
  needsUsername: boolean
  needsDob: boolean
  email?: string
}

function FieldError({ message }: { message?: string | undefined }) {
  if (!message) {
    return null
  }

  return <p className="text-sm text-destructive">{message}</p>
}

// Today as YYYY-MM-DD, so the date picker cannot select a future date.


// Shown to two kinds of people:
//  - a brand new Google user: no account exists yet, they choose a username,
//    give a date of birth and accept the checkboxes, and this creates the account
//  - a signed-in account that has no date of birth or has not accepted the
//    current Terms and Privacy Policy
// Nothing else in the app works until this is complete (the server enforces it).
export function Onboarding() {
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh, signOut } = useAuth()
  const redirectTo: string = location.state?.from?.pathname ?? "/dashboard"

  const [info, setInfo] = useState<OnboardingInfo | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const data = await apiFetch<OnboardingInfo>("/auth/onboarding")

        if (cancelled) {
          return
        }

        // Already complete (for example a second tab finished it).
        if (!data.required) {
          await refresh()
          navigate(redirectTo, { replace: true })
          return
        }

        setInfo(data)
      } catch (error) {
        if (cancelled) {
          return
        }

        // No session and no pending Google sign-in: nothing to finish.
        if (error instanceof ApiError && error.status === 401) {
          navigate("/sign-in", { replace: true })
          return
        }

        setFormError("Could not load this page. Please refresh and try again.")
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [navigate, redirectTo, refresh])

  function showError(error: unknown) {
    if (error instanceof ApiError) {
      setFieldErrors(error.fieldErrors)
      // Only show a general message when no specific field has one.
      setFormError(
        Object.keys(error.fieldErrors).length === 0 ? error.message : ""
      )
      return
    }

    setFormError("Something went wrong. Please try again.")
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (loading || !info) {
      return
    }

    const data = new FormData(event.currentTarget)
    const username = String(data.get("username") ?? "").trim()
    const dateOfBirth = String(data.get("dateOfBirth") ?? "").trim()
    const confirmedAdult = data.get("confirmedAdult") === "on"
    const acceptedTerms = data.get("acceptedTerms") === "on"

    // Quick checks for a fast response. The server repeats all of them.
    const errors: Record<string, string> = {}

    if (info.needsUsername && !username) {
      errors.username = "Choose a username"
    }

    if (info.needsDob) {
      const dobResult = dobSchema.safeParse(dateOfBirth)

      if (!dobResult.success) {
        errors.dateOfBirth =
          dobResult.error.issues[0]?.message ?? "Enter a valid date of birth"
      } else if (!isAdult(dobResult.data)) {
        errors.dateOfBirth = "You must be 18 or older to create an account"
      }
    }

    if (!confirmedAdult) {
      errors.confirmedAdult = "You must confirm you are 18 or older"
    }

    if (!acceptedTerms) {
      errors.acceptedTerms =
        "You must accept the Terms of Service and Privacy Policy"
    }

    if (Object.keys(errors).length > 0) {
      setFormError("")
      setFieldErrors(errors)
      return
    }

    setLoading(true)
    setFieldErrors({})
    setFormError("")

    try {
      await apiFetch("/auth/onboarding/complete", {
        method: "POST",
        body: {
          ...(info.needsUsername ? { username } : {}),
          ...(info.needsDob ? { dateOfBirth } : {}),
          confirmedAdult,
          acceptedTerms,
        },
      })

      // Update the shared auth state first so the protected route sees the user.
      await refresh()
      navigate(redirectTo, { replace: true })
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }

  async function handleSignOut() {
    await signOut()
    navigate("/sign-in", { replace: true })
  }

  if (!info) {
    return (
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
        {formError ? (
          <p role="alert" className="text-sm text-destructive pointer-events-auto">
            {formError}
          </p>
        ) : (
          <Skeleton className="h-96 w-full max-w-sm" />
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
      <Card className="w-full max-w-sm pointer-events-auto max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>
            {info.needsUsername ? "Finish creating your account" : "One more step"}
          </CardTitle>
          <CardDescription>
            {info.needsUsername && info.email
              ? `Signed in with Google as ${info.email}. Choose a username and complete the details below to continue.`
              : "We need a few details before you can continue."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="onboarding-form" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              {info.needsUsername && (
                <div className="grid gap-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    placeholder="Enter a unique username"
                    aria-invalid={!!fieldErrors.username}
                    required
                  />
                  <FieldError message={fieldErrors.username} />
                </div>
              )}

              {info.needsDob && (
                <div className="grid gap-2">
                  <Label htmlFor="date-of-birth">Date of birth</Label>
                  <DobPicker invalid={!!fieldErrors.dateOfBirth} />
                  <FieldError message={fieldErrors.dateOfBirth} />
                </div>
              )}

              <div className="grid gap-3">
                <div className="grid gap-1">
                  <div className="flex items-start gap-2">
                    <input
                      id="confirmed-adult"
                      name="confirmedAdult"
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      aria-invalid={!!fieldErrors.confirmedAdult}
                    />
                    <Label
                      htmlFor="confirmed-adult"
                      className="text-sm font-normal leading-snug"
                    >
                      I confirm that I am 18 years of age or older
                    </Label>
                  </div>
                  <FieldError message={fieldErrors.confirmedAdult} />
                </div>

                <div className="grid gap-1">
                  <div className="flex items-start gap-2">
                    <input
                      id="accepted-terms"
                      name="acceptedTerms"
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      aria-invalid={!!fieldErrors.acceptedTerms}
                    />
                    <Label
                      htmlFor="accepted-terms"
                      className="text-sm font-normal leading-snug"
                    >
                      <span>
                        I agree to the{" "}
                        <Link
                          to="/terms"
                          target="_blank"
                          className="underline underline-offset-4"
                        >
                          Terms of Service
                        </Link>{" "}
                        and{" "}
                        <Link
                          to="/privacy"
                          target="_blank"
                          className="underline underline-offset-4"
                        >
                          Privacy Policy
                        </Link>
                      </span>
                    </Label>
                  </div>
                  <FieldError message={fieldErrors.acceptedTerms} />
                </div>
              </div>

              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
            </div>
          </form>
        </CardContent>
        <CardFooter className="flex-col gap-2">
          <Button
            type="submit"
            form="onboarding-form"
            className="w-full"
            disabled={loading}
          >
            {loading ? "Saving..." : "Continue"}
          </Button>

          <Button variant="link" onClick={handleSignOut} disabled={loading}>
            Not you? Sign out
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}