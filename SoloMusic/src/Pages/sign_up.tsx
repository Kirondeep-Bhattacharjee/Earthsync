import { useState } from "react"
import type { FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { GoogleLogin } from "@react-oauth/google"
import { Button } from "@/components/ui/button"
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
import { apiFetch, ApiError, type AuthUser } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { dobSchema, isAdult } from "@/lib/dob"

type AuthResponse = {
  message: string
  user: AuthUser | null
  isNewUser?: boolean
  onboardingRequired?: boolean
}

function FieldError({ message }: { message?: string | undefined }) {
  if (!message) {
    return null
  }

  return <p className="text-sm text-destructive">{message}</p>
}

// Today as YYYY-MM-DD, so the date picker cannot select a future date.
function todayString() {
  return new Date().toISOString().slice(0, 10)
}

export function SignUp() {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState("")
  const [loading, setLoading] = useState(false)

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

    if (loading) {
      return
    }

    const data = new FormData(event.currentTarget)
    const username = String(data.get("username") ?? "").trim()
    const email = String(data.get("email") ?? "").trim()
    const password = String(data.get("password") ?? "")
    const confirmPassword = String(data.get("confirmPassword") ?? "")
    const dateOfBirth = String(data.get("dateOfBirth") ?? "").trim()
    const confirmedAdult = data.get("confirmedAdult") === "on"
    const acceptedTerms = data.get("acceptedTerms") === "on"

    // Quick checks for a fast response. The server repeats all of them.
    const errors: Record<string, string> = {}

    if (password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match"
    }

    const dobResult = dobSchema.safeParse(dateOfBirth)

    if (!dobResult.success) {
      errors.dateOfBirth =
        dobResult.error.issues[0]?.message ?? "Enter a valid date of birth"
    } else if (!isAdult(dobResult.data)) {
      errors.dateOfBirth = "You must be 18 or older to create an account"
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
      await apiFetch<AuthResponse>("/auth/sign-up", {
        method: "POST",
        body: {
          username,
          email,
          password,
          dateOfBirth,
          confirmedAdult,
          acceptedTerms,
        },
      })

      // Update the shared auth state first so the protected route sees the user.
      await refresh()
      navigate("/dashboard", { replace: true })
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle(credential: string | undefined) {
    if (!credential) {
      setFormError("Google sign-in failed. Please try again.")
      return
    }

    setLoading(true)
    setFieldErrors({})
    setFormError("")

    try {
      const result = await apiFetch<AuthResponse>("/auth/google", {
        method: "POST",
        body: { credential },
      })

      // Update the shared auth state first so the protected route sees the user.
      await refresh()

      // A new Google user has no account yet: onboarding collects the username,
      // date of birth and consents, and creates it.
      navigate(result.onboardingRequired ? "/onboarding" : "/dashboard", {
        replace: true,
      })
    } catch (error) {
      showError(error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
      <Card className="w-full max-w-sm pointer-events-auto max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
          <CardDescription>
            Enter your email below to create your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="signup-form" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
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

                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="m@example.com"
                  aria-invalid={!!fieldErrors.email}
                  required
                />
                <FieldError message={fieldErrors.email} />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="password">Create a Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={72}
                  aria-invalid={!!fieldErrors.password}
                  required
                />
                <FieldError message={fieldErrors.password} />

                <Label htmlFor="confirm-password">Confirm Password</Label>
                <Input
                  id="confirm-password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!fieldErrors.confirmPassword}
                  required
                />
                <FieldError message={fieldErrors.confirmPassword} />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="date-of-birth">Date of birth</Label>
                <Input
                  id="date-of-birth"
                  name="dateOfBirth"
                  type="date"
                  autoComplete="bday"
                  min="1900-01-01"
                  max={todayString()}
                  aria-invalid={!!fieldErrors.dateOfBirth}
                  required
                />
                <FieldError message={fieldErrors.dateOfBirth} />
              </div>

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
          {/* Outside the <form>, so it points at it with the form attribute */}
          <Button
            type="submit"
            form="signup-form"
            className="w-full"
            disabled={loading}
          >
            {loading ? "Creating account..." : "Create Account"}
          </Button>

          <div
            className={`flex w-full justify-center ${
              loading ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <GoogleLogin
              onSuccess={(response) => handleGoogle(response.credential)}
              onError={() =>
                setFormError("Google sign-in failed. Please try again.")
              }
              text="signup_with"
              theme="outline"
              shape="rectangular"
              width="300"
            />
          </div>

          <Button variant="link" onClick={() => navigate("/sign-in")}>
            Already have an account? Sign In
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}