import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL,
});

try {
  const { rows } = await pool.query(`
    select table_schema, table_name
    from information_schema.tables
    where table_schema in ('public', 'drizzle')`);
  console.log(rows);
} catch (e) {
  console.error(e);
} finally {
  await pool.end();
}