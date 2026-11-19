import "dotenv/config";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import authRouter from "./routes/auth.js";
import dashboardRouter from "./routes/dashboard.js";
import profileRouter from "./routes/profile.js";
import { requireAuth } from "./middlewares/requireAuth.js";
import { sessionMiddleware } from "./lib/session.js";
import usersRouter from "./routes/users.js";
import friendsRouter from "./routes/friends.js";
import chatRouter from "./routes/chat.js";
import postsRouter from "./routes/posts.js";
import postInteractionsRouter from "./routes/post-interactions.js"

const app = express();

const isProduction = process.env.NODE_ENV === "production";

// Needed behind a hosting proxy (Render, Railway, Nginx...) so secure cookies work.
if (isProduction) {
    app.set("trust proxy", 1);
}

app.use(
    cors({
        origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
        credentials: true,
    })
);

// Parse incoming request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Postgres-backed sessions (config lives in lib/session.ts)
app.use(sessionMiddleware);

app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
});

// Register API routes (final URLs look like /api/auth/sign-in)
app.use("/api", authRouter);
app.use("/api", profileRouter);

app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api", usersRouter);
app.use("/api", friendsRouter);
app.use("/api", chatRouter);
app.use("/api", postsRouter);
app.use("/api", postInteractionsRouter)

// Handle requests to unknown routes
app.use((_req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found",
    });
});

// Catch-all error handler (must be last). Returns JSON instead of an HTML error page.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string };

    if (e?.type === "entity.parse.failed") {
        res.status(400).json({ success: false, message: "Invalid JSON body" });
        return;
    }

    console.error("Unhandled error:", err);
    res.status(500).json({
        success: false,
        message: "An internal server error occurred",
    });
});

export default app;