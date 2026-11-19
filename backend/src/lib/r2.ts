import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { HttpError } from "./http.js";

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
const postsBucket = process.env.R2_POSTS_BUCKET;

const AVATAR_PREFIX = "avatars/";
const POSTS_PREFIX = "posts/";

const client =
    accountId && accessKeyId && secretAccessKey
        ? new S3Client({
              region: "auto",
              endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
              credentials: { accessKeyId, secretAccessKey },
              // R2 doesn't support the SDK's newer default checksums.
              requestChecksumCalculation: "WHEN_REQUIRED",
              responseChecksumValidation: "WHEN_REQUIRED",
          })
        : null;

function requireStorage() {
    if (!client || !bucket) {
        console.error("R2 is not configured: check the R2_* env vars");
        throw new HttpError(503, "File storage is not available");
    }

    return { client, bucket };
}

function requirePostsStorage() {
    if (!client || !postsBucket) {
        console.error("R2 posts bucket is not configured: check R2_POSTS_BUCKET");
        throw new HttpError(503, "File storage is not available");
    }

    return { client, bucket: postsBucket };
}

/* ------------------------------------------------------------------ */
/* Avatars (public bucket)                                             */
/* ------------------------------------------------------------------ */

// A new key on every upload means the old image is never overwritten, so the
// CDN can cache each file forever and a failed DB update can't corrupt anything.
// Ownership is tracked by the profiles row, not by the path.
export function createAvatarKey(): string {
    return `${AVATAR_PREFIX}${randomUUID()}.webp`;
}

export async function putAvatar(key: string, body: Buffer): Promise<void> {
    const storage = requireStorage();

    await storage.client.send(
        new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: body,
            ContentType: "image/webp",
            CacheControl: "public, max-age=31536000, immutable",
        })
    );
}

// Best-effort: a failed delete only leaves an unused file behind, so it is
// logged and never thrown. The user must not see an error because of it.
export async function deleteAvatar(key: string): Promise<void> {
    // Never delete anything outside the avatars folder, whatever the DB holds.
    if (!key.startsWith(AVATAR_PREFIX)) {
        console.error(`Refusing to delete non-avatar key: ${key}`);
        return;
    }

    try {
        const storage = requireStorage();

        await storage.client.send(
            new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })
        );
    } catch (error) {
        console.error(`R2 delete failed for ${key}:`, error);
    }
}

/* ------------------------------------------------------------------ */
/* Posts (private bucket, signed URLs only)                            */
/* ------------------------------------------------------------------ */

// The signing time is rounded down to a 30 minute bucket, so the same file
// gets the same URL within a bucket and the browser can cache it instead of
// re-downloading the grid on every visit. Each URL is valid for 30 to 60
// minutes from when it is handed out.
const SIGN_BUCKET_MS = 30 * 60 * 1000;
const SIGN_EXPIRES_SECONDS = 60 * 60;

// Ownership is tracked by the posts and media rows, the user id in the path is
// only for tidiness. The thumbnail shares the uuid of its file.
export function createPostKeys(userId: number, type: "image" | "video") {
    const id = randomUUID();
    const extension = type === "video" ? "mp4" : "webp";

    return {
        key: `${POSTS_PREFIX}${userId}/${id}.${extension}`,
        thumbKey: `${POSTS_PREFIX}${userId}/${id}-thumb.webp`,
    };
}

export async function putPostObject(
    key: string,
    body: Buffer,
    contentType: string
): Promise<void> {
    const storage = requirePostsStorage();

    await storage.client.send(
        new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            // Private: only signed URLs reach this, and keys never change.
            CacheControl: "private, max-age=31536000, immutable",
        })
    );
}

// Call this only after the route has decided the viewer may see the post.
export async function signPostUrl(key: string): Promise<string> {
    const storage = requirePostsStorage();

    return getSignedUrl(
        storage.client,
        new GetObjectCommand({ Bucket: storage.bucket, Key: key }),
        {
            expiresIn: SIGN_EXPIRES_SECONDS,
            signingDate: new Date(
                Math.floor(Date.now() / SIGN_BUCKET_MS) * SIGN_BUCKET_MS
            ),
        }
    );
}

// Best-effort, like deleteAvatar: a failed delete leaves an unused file
// behind, it must not turn into an error for the user.
export async function deletePostObjects(keys: string[]): Promise<void> {
    let storage: ReturnType<typeof requirePostsStorage>;

    try {
        storage = requirePostsStorage();
    } catch {
        return;
    }

    await Promise.all(
        keys.map(async (key) => {
            // Never delete anything outside the posts folder.
            if (!key.startsWith(POSTS_PREFIX)) {
                console.error(`Refusing to delete non-post key: ${key}`);
                return;
            }

            try {
                await storage.client.send(
                    new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })
                );
            } catch (error) {
                console.error(`R2 delete failed for ${key}:`, error);
            }
        })
    );
}