import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

// Direct connection (not the pooled URL), same WebSocket transport as the app.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
await pool.end();

console.log("Migrations applied");