import { Navigate, Outlet, useLocation } from "react-router-dom"
import { useAuth } from "@/lib/auth"
import { PageSkeleton } from "@/components/skeletons/page-skeleton"
export function ProtectedRoute() {
  const { user, onboardingRequired, loading } = useAuth()
  const location = useLocation()

  // Wait for the /auth/me check so a refresh doesn't bounce logged-in users
  if (loading) {
  return (
    <div className="p-6">
      <PageSkeleton />
    </div>
  )
}

  if (!user) {
    return <Navigate to="/sign-in" replace state={{ from: location }} />
  }

  // Signed in but no date of birth / current consents yet: nothing behind this
  // route works until onboarding is done (the server refuses it as well).
  if (onboardingRequired) {
    return <Navigate to="/onboarding" replace state={{ from: location }} />
  }

  return <Outlet />
}