import { createContext, useCallback, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { apiFetch, type AuthUser } from "@/lib/api"

type AuthState = {
  user: AuthUser | null
  // True when the account is signed in but has not given a date of birth or
  // accepted the current Terms and Privacy Policy yet.
  onboardingRequired: boolean
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [onboardingRequired, setOnboardingRequired] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{
        user: AuthUser
        onboardingRequired?: boolean
      }>("/auth/me")
      setUser(data.user)
      setOnboardingRequired(data.onboardingRequired ?? false)
    } catch {
      setUser(null) // 401 means not logged in
      setOnboardingRequired(false)
    } finally {
      setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/auth/sign-out", { method: "POST" })
    } finally {
      setUser(null)
      setOnboardingRequired(false)
    }
  }, [])

  // Checks the session cookie once on page load
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <AuthContext.Provider
      value={{ user, onboardingRequired, loading, refresh, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }

  return context
}