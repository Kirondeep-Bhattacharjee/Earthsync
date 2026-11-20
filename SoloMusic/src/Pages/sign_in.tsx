import { useState } from "react"
import type { FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { GoogleLogin } from "@react-oauth/google"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch, ApiError, type AuthUser } from "@/lib/api"
import { useAuth } from "@/lib/auth"

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

export function SignIn() {
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh } = useAuth()
  // Go back to the page the user originally wanted, otherwise the dashboard.
  const redirectTo: string = location.state?.from?.pathname ?? "/dashboard"
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

  // Accounts that still need a date of birth and consents (including every new
  // Google user) go to onboarding first, then on to where they wanted to go.
  function goNext(onboardingRequired: boolean | undefined) {
    if (onboardingRequired) {
      navigate("/onboarding", {
        replace: true,
        state: { from: { pathname: redirectTo } },
      })
      return
    }

    navigate(redirectTo, { replace: true })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (loading) {
      return
    }

    const data = new FormData(event.currentTarget)
    const identifier = String(data.get("identifier") ?? "").trim()
    const password = String(data.get("password") ?? "")

    setLoading(true)
    setFieldErrors({})
    setFormError("")

    try {
      const result = await apiFetch<AuthResponse>("/auth/sign-in", {
        method: "POST",
        body: { identifier, password },
      })

      // Update the shared auth state first so the protected route sees the user.
      await refresh()
      goNext(result.onboardingRequired)
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
      goNext(result.onboardingRequired)
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
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold">Login to your account</h1>
            <p className="text-sm text-muted-foreground">
              Don&apos;t have an account?{" "}
              <Link to="/sign-up" className="underline underline-offset-4">
                Sign up
              </Link>
            </p>
          </div>

          <form id="signin-form" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-5">
              <div className="grid gap-2">
                <Label htmlFor="identifier">Email or username</Label>
                <Input
                  id="identifier"
                  name="identifier"
                  type="text"
                  autoComplete="username"
                  placeholder="m@example.com"
                  aria-invalid={!!fieldErrors.identifier}
                  required
                />
                <FieldError message={fieldErrors.identifier} />
              </div>

              <div className="grid gap-2">
                <div className="flex items-center">
                  <Label htmlFor="password">Password</Label>
                  <a
                    href="#"
                    className="ml-auto inline-block text-sm underline-offset-4 hover:underline"
                  >
                    Forgot your password?
                  </a>
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={!!fieldErrors.password}
                  required
                />
                <FieldError message={fieldErrors.password} />
              </div>

              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Logging in..." : "Login"}
              </Button>
            </div>
          </form>

          <div
            role="separator"
            className="my-5 flex w-full items-center gap-3 text-xs text-muted-foreground"
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
              text="signin_with"
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