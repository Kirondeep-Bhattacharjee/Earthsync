import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// Must match SESSION_COOKIE_NAME in routes/auth.ts
export const SESSION_COOKIE_NAME = "sync.sid";

const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
    throw new Error("SESSION_SECRET is not configured");
}

// Use the same variable your db/index.ts reads. The pooled Neon URL is fine here.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
}

const isProduction = process.env.NODE_ENV === "production";

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const PgSession = connectPgSimple(session);

// A small dedicated pool: sessions are simple queries, so a plain TCP
// connection works and keeps the Neon WebSocket driver out of it.
const pool = new pg.Pool({ connectionString, max: 5 });

// Exported so the WebSocket server can look up a session from its cookie later.
export const sessionStore = new PgSession({
    pool,
    tableName: "session", // created by the Drizzle migration, see db/schema.ts
    // Seconds between cleanups of expired rows. Kept long so an idle Neon
    // database isn't woken up every few minutes just for housekeeping.
    pruneSessionInterval: 60 * 60,
});

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

// Shared by Express and the WebSocket upgrade handler, so both read the
// same cookie in exactly the same way.
export const sessionMiddleware = session({
    store: sessionStore,
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // push expiry forward on every request, so active users stay signed in
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    },
});