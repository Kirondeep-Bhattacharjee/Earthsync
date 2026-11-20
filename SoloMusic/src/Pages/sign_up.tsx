import { useState } from "react"
import type { FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { GoogleLogin } from "@react-oauth/google"
import { Button } from "@/components/ui/button"
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
    // Fills the space under the Navbar (the parent <main> is a flex column).
    <div className="grid min-h-0 w-full flex-1 lg:grid-cols-2">
      {/* Left: the form */}
      <div className="flex items-center justify-center px-6 py-6 md:px-10">
        <div className="w-full max-w-md">
          <div className="mb-5 flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold">Create your account</h1>
            <p className="text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link to="/sign-in" className="underline underline-offset-4">
                Sign in
              </Link>
            </p>
          </div>

          <form id="signup-form" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    placeholder="Unique username"
                    aria-invalid={!!fieldErrors.username}
                    required
                  />
                  <FieldError message={fieldErrors.username} />
                </div>

                <div className="grid gap-1.5">
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
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="password">Password</Label>
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
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="confirm-password">Confirm password</Label>
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
              </div>

              <div className="grid gap-1.5">
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

              <div className="grid gap-2">
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

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Creating account..." : "Create Account"}
              </Button>
            </div>
          </form>

          {/* Separate path: Google asks for its own details on the next step */}
          <div
            role="separator"
            className="my-4 flex w-full items-center gap-3 text-xs text-muted-foreground"
          >
            <div className="h-px flex-1 bg-border" />
            <span>or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

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
        </div>
      </div>

      {/* Right: image panel (desktop only) */}
      <div className="relative hidden bg-muted lg:block">
        <div className="absolute inset-0 bg-primary/10" />
        <img
          src="/auth-side.jpg"
          alt=""
          className="absolute inset-0 h-full w-full object-cover dark:brightness-[0.4]"
          // No image file yet? Hide the broken icon and show the plain panel.
          onError={(event) => {
            event.currentTarget.style.display = "none"
          }}
        />
      </div>
    </div>
  )
}