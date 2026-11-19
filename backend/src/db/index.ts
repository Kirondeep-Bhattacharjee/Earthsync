import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

// Node needs a WebSocket implementation for the Neon driver
neonConfig.webSocketConstructor = ws;

const connectionString =
    process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error("DATABASE_URL_POOLED or DATABASE_URL must be configured");
}

const pool = new Pool({ connectionString });

export const db = drizzle({ client: pool });