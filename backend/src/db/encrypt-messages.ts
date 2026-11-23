import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { messages } from "./schema.js";
import { encryptText, messageAad } from "../lib/crypto.js";

neonConfig.webSocketConstructor = ws;

// One-off: encrypts messages that were saved as plaintext before encryption
// existed. Safe to run more than once (it only touches rows that still have
// plaintext and no ciphertext). Run it after the new sendMessage is deployed,
// so no new plaintext rows appear while it works.
const BATCH = 500;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL_POOLED,
});
const db = drizzle({ client: pool });

let cursor = 0;
let done = 0;

for (;;) {
    const rows = await db
        .select({
            id: messages.id,
            conversationId: messages.conversationId,
            senderId: messages.senderId,
            body: messages.body,
        })
        .from(messages)
        .where(
            and(
                gt(messages.id, cursor),
                isNotNull(messages.body),
                isNull(messages.bodyEnc)
            )
        )
        .orderBy(asc(messages.id))
        .limit(BATCH);

    if (rows.length === 0) {
        break;
    }

    await db.transaction(async (tx) => {
        for (const row of rows) {
            if (row.body === null) {
                continue;
            }

            const { bodyEnc, keyVersion } = encryptText(
                row.body,
                messageAad(row.conversationId, row.senderId)
            );

            // body = null in the same statement, so a row is never left with
            // both a plaintext and an encrypted copy.
            await tx
                .update(messages)
                .set({ bodyEnc, keyVersion, body: null })
                .where(and(eq(messages.id, row.id), isNull(messages.bodyEnc)));
        }
    });

    done += rows.length;
    cursor = rows[rows.length - 1]!.id;
    console.log(`Encrypted ${done} messages so far`);
}

await pool.end();
console.log(`Done. ${done} messages encrypted.`);