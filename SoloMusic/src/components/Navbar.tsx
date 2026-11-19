import { Button } from "@/components/ui/button"

import SyncLogo from "../assets/sync-logo.svg";

import {ModeToggle} from "./mode-toggle"

import {useNavigate} from "react-router-dom"
import { useAuth } from "@/lib/auth"

import EarthLogo from "../assets/earthsync-mark.svg"


export default function Navbar() {
    const navigate = useNavigate();
    const { user, loading, signOut } = useAuth();

    async function handleSignOut() {
        await signOut();
        navigate("/sign-in", { replace: true });
    }

    return (
        // relative z-20: sits above the sky layer so its buttons always get clicks.
        // Mobile: simple flex row. md and up: three-column grid with the search centred.
        <nav className="relative z-20 flex items-center justify-between gap-2 bg-background p-4 text-foreground">

            <div className="flex min-w-0 items-center gap-1">
                <img
                    src={EarthLogo}
                    alt="EarthSync Logo"
                    className="h-8 w-auto shrink-0 cursor-pointer dark:invert sm:h-10"
                    onClick={() => navigate("/")}
                />

                <img
                    src={SyncLogo}
                    alt=""
                    className="h-9 w-auto cursor-pointer dark:invert sm:h-12"
                    onClick={() => navigate("/")}
                />
            </div>

            {/* Hidden on small screens; shown from md up. */}
            

            <div className="flex shrink-0 items-center gap-2">
                <ModeToggle />

                {/* While /auth/me is still loading, show neither set of buttons,
                    so logged-in users don't see Sign In flash on refresh. */}
                {!loading && user && (
                    <Button
                        variant="outline"
                        className="h-8 cursor-pointer px-3 sm:h-9 sm:px-4"
                        onClick={() => void handleSignOut()}
                    >
                        Sign Out
                    </Button>
                )}

                {!loading && !user && (
                    <>
                        <Button
                            className="h-8 cursor-pointer bg-background px-3 text-foreground hover:bg-background sm:h-9 sm:px-4"
                            onClick={() => navigate("/sign-up")}
                        >
                            Sign Up
                        </Button>
                        <Button
                            className="h-8 cursor-pointer px-3 sm:h-9 sm:px-4"
                            onClick={() => navigate("/sign-in")}
                        >
                            Sign In
                        </Button>
                    </>
                )}
            </div>
        </nav>
    );
};