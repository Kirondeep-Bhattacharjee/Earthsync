import Navbar from "./components/Navbar"

import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom"
import { GoogleOAuthProvider } from "@react-oauth/google"
import Home from "./Pages/home"
import { SignIn } from "./Pages/sign_in"
import { SignUp } from "./Pages/sign_up"
import { Onboarding } from "./Pages/onboarding"

import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth"
import { ProtectedRoute } from "@/components/ProtectedRoute"
import { SyncLayout } from "@/components/SyncLayout"
import { ChatSocketProvider } from "@/lib/chat-socket"
import { lazy } from "react"

const Dashboard = lazy(() => import("./Pages/dashboard"))
const Profile = lazy(() => import("./Pages/profile"))
const UserProfile = lazy(() => import("./Pages/user-profile"))
const Connect = lazy(() => import("@/Pages/connect"))
const Chats = lazy(() => import("./Pages/chats"))
const ChatThread = lazy(() => import("./Pages/chat-thread"))
const Settings = lazy(() => import("./Pages/settings"))

   

import Friends from "@/Pages/friends"
import Requests from "@/Pages/requests"

function Publiclayout() {
  return (
    <div className="flex flex-col w-full min-h-screen bg-background text-foreground gap-0">
      <Navbar />
      <main className="flex flex-col flex-1 items-center w-full">
        <Outlet />
      </main>
    </div>
  )
}

export function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ""}>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              {/* Public pages: Navbar on top */}
              <Route element={<Publiclayout />}>
                <Route path="/" element={<Home />} />
                <Route path="/sign-in" element={<SignIn />} />
                <Route path="/sign-up" element={<SignUp />} />
                {/* Not protected: a new Google user has no account until this is done */}
                <Route path="/onboarding" element={<Onboarding />} />
              </Route>

              {/* Protected pages: sidebar layout, no Navbar */}
              <Route element={<ProtectedRoute />}>
                {/* One chat WebSocket for every protected page */}
                <Route element={<ChatSocketProvider />}>
                  <Route element={<SyncLayout />}>
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/u/:username" element={<UserProfile />} />
                    <Route path="/connect" element={<Connect />} />
                    <Route path="/friends" element={<Friends />} />
                    <Route path="/requests" element={<Requests />} />
                    <Route path="/chats" element={<Chats />} />
                    <Route path="/chats/:username" element={<ChatThread />} />
                    <Route path="/settings" element={<Settings />} />
                    
                    {/* every future protected page goes here */}
                  </Route>
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </GoogleOAuthProvider>
    </ThemeProvider>
  )
}

export default App