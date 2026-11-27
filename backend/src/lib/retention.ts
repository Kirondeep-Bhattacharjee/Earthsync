import { and, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
    media,
    messageDeletions,
    messagePins,
    messageStars,
    messages,
} from "../db/schema.js";
import { deleteChatObjects } from "./r2.js";

// The retention worker. It wipes the CONTENT of messages that no one can see
// any more, for good:
//   1. expired disappearing messages (expires_at has passed), and
//   2. messages deleted for everyone, 30 days after the deletion.
// The message row stays as an empty tombstone (ids, receipts and the "Message
// unavailable" quote above a reply keep working); only text, the media row and
// its files in R2 go. Pins, stars and "deleted for me" marks of the message go
// too. Everything is safe to repeat: a row is only picked while it still has
// content.

const BATCH_SIZE = 200;
// How long a message deleted for everyone keeps its content (see schema.ts).
const DELETED_RETENTION_DAYS = 30;
// A run never loops forever: at most this many batches, then it waits for the
// next tick.
const MAX_BATCHES_PER_RUN = 50;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;

export type PurgeResult = {
    messages: number;
    mediaFiles: number;
};

// A message still holds content when any of these is set.
const hasContent = sql`(${messages.body} is not null or ${messages.bodyEnc} is not null or ${messages.mediaId} is not null)`;

// One batch. Returns how many messages it wiped (0 = nothing left to do).
// Compared with now() in SQL, never JS dates, like the rest of the repo.
export async function purgeBatch(database: typeof db = db): Promise<PurgeResult> {
    const { ids, keys } = await database.transaction(async (tx) => {
        // SKIP LOCKED: two servers running the worker never wait on each other.
        const rows = await tx
            .select({ id: messages.id, mediaId: messages.mediaId })
            .from(messages)
            .where(
                and(
                    hasContent,
                    or(
                        // Expired and not wiped yet.
                        and(
                            isNotNull(messages.expiresAt),
                            lte(messages.expiresAt, sql`now()`),
                            isNull(messages.contentPurgedAt)
                        ),
                        // Deleted for everyone long enough ago.
                        and(
                            isNotNull(messages.deletedForEveryoneAt),
                            lte(
                                messages.deletedForEveryoneAt,
                                sql`now() - make_interval(days => ${DELETED_RETENTION_DAYS}::int)`
                            )
                        )
                    )
                )
            )
            .limit(BATCH_SIZE)
            .for("update", { skipLocked: true });

        if (rows.length === 0) {
            return { ids: [] as number[], keys: [] as string[] };
        }

        const ids = rows.map((row) => row.id);
        const mediaIds = rows
            .map((row) => row.mediaId)
            .filter((id): id is string => id !== null);

        const mediaRows =
            mediaIds.length > 0
                ? await tx
                      .select({ key: media.key, thumbKey: media.thumbKey })
                      .from(media)
                      .where(inArray(media.id, mediaIds))
                : [];

        // Content first (this also frees the media_id foreign key), then the
        // media rows. A message that was already deleted for everyone keeps its
        // own marker; an expired one gets content_purged_at.
        await tx
            .update(messages)
            .set({
                body: null,
                bodyEnc: null,
                keyVersion: null,
                mediaId: null,
                contentPurgedAt: sql`coalesce(${messages.contentPurgedAt}, now())`,
            })
            .where(inArray(messages.id, ids));

        await tx.delete(messagePins).where(inArray(messagePins.messageId, ids));
        await tx.delete(messageStars).where(inArray(messageStars.messageId, ids));
        await tx
            .delete(messageDeletions)
            .where(inArray(messageDeletions.messageId, ids));

        if (mediaIds.length > 0) {
            await tx.delete(media).where(inArray(media.id, mediaIds));
        }

        return {
            ids,
            keys: mediaRows.flatMap((row) =>
                row.thumbKey ? [row.key, row.thumbKey] : [row.key]
            ),
        };
    });

    // Files go after the database commit. deleteChatObjects never throws and
    // only touches the chat folder; a failure is logged and leaves an unused
    // file behind, never a message that points at a missing file.
    await deleteChatObjects(keys);

    return { messages: ids.length, mediaFiles: keys.length };
}

// Runs batches until nothing is left (or the safety cap is reached).
export async function purgeOnce(database: typeof db = db): Promise<PurgeResult> {
    const total: PurgeResult = { messages: 0, mediaFiles: 0 };

    for (let i = 0; i < MAX_BATCHES_PER_RUN; i += 1) {
        const result = await purgeBatch(database);

        total.messages += result.messages;
        total.mediaFiles += result.mediaFiles;

        if (result.messages < BATCH_SIZE) {
            break;
        }
    }

    return total;
}

// Starts the loop and returns a stop function. Uses setTimeout (not
// setInterval) so a slow run is never overlapped by the next one. A failed run
// is logged and tried again on the next tick; the worker never crashes the
// server. Set RETENTION_ENABLED=false to turn it off (for example on a second
// server, or while testing), RETENTION_INTERVAL_MS to change the 5 minutes.
export function startRetentionWorker(): () => void {
    if (process.env.RETENTION_ENABLED === "false") {
        console.log("Retention worker is off (RETENTION_ENABLED=false)");
        return () => {};
    }

    const configured = Number(process.env.RETENTION_INTERVAL_MS);
    const intervalMs =
        Number.isFinite(configured) && configured >= 10_000
            ? configured
            : DEFAULT_INTERVAL_MS;

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    async function tick() {
        try {
            const result = await purgeOnce();

            if (result.messages > 0) {
                console.log(
                    `Retention: wiped ${result.messages} message(s), ${result.mediaFiles} file(s)`
                );
            }
        } catch (error) {
            console.error("Retention worker error:", error);
        } finally {
            if (!stopped) {
                timer = setTimeout(tick, intervalMs);
                timer.unref();
            }
        }
    }

    timer = setTimeout(tick, FIRST_RUN_DELAY_MS);
    timer.unref();

    return () => {
        stopped = true;

        if (timer) {
            clearTimeout(timer);
        }
    };
}
