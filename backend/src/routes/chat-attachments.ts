import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth.js";
import { handleError, validationError } from "../lib/http.js";
import {
    assertCanSendAttachment,
    chatMessageFromSent,
    findPeer,
    sendAttachment,
} from "../lib/chat.js";
import {
    CHAT_IMAGE_MAX_BYTES,
    processChatImage,
    processVoice,
} from "../lib/chat-media.js";
import { createChatKeys, deleteChatObjects, putChatObject } from "../lib/r2.js";
import { announceMessage } from "../lib/socket.js";
import { usernameSchema } from "../lib/username.js";

const router = Router();

const attachmentSchema = z.object({
    username: usernameSchema,
    kind: z.enum(["image", "voice"]),
    // Optional: the message this photo or voice note replies to.
    replyToId: z.coerce.number().int().positive().optional(),
});

// Written to disk, like posts. The processors enforce the exact limits
// (5 MB photos, 3 MB voice); this is only the outer cap.
const upload = multer({
    storage: multer.diskStorage({ destination: tmpdir() }),
    limits: { fileSize: CHAT_IMAGE_MAX_BYTES, files: 1 },
});

function receiveFile(req: Request, res: Response, next: NextFunction) {
    upload.single("file")(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }

        if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                res.status(413).json({ message: "That file is too large" });
                return;
            }

            res.status(400).json({ message: "Invalid upload" });
            return;
        }

        handleError(res, error, "Chat upload");
    });
}

const attachmentLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "You are sending files too fast. Slow down." },
});

// Multipart form: "file", "username", "kind" (image | voice). Friends only.
router.post(
    "/messages/attachment",
    requireAuth,
    attachmentLimiter,
    receiveFile,
    async (req, res) => {
        const viewerId = req.session.userId;
        const file = req.file;
        let uploadedKeys: string[] = [];

        try {
            if (viewerId === undefined) {
                return res.status(401).json({ message: "Not authenticated" });
            }

            const parsed = attachmentSchema.safeParse(req.body ?? {});

            if (!parsed.success) {
                return validationError(res, parsed.error);
            }

            if (!file) {
                return res.status(400).json({ message: "Choose a file to send" });
            }

            const peerId = await findPeer(viewerId, parsed.data.username);

            // Refuse strangers before spending any CPU on the file.
            await assertCanSendAttachment(viewerId, peerId);

            const processed =
                parsed.data.kind === "image"
                    ? await processChatImage(file)
                    : await processVoice(file);

            const { key, thumbKey } = createChatKeys(viewerId, processed.type);

            uploadedKeys = thumbKey ? [key, thumbKey] : [key];

            // Upload first: if this fails, nothing in the database changed.
            await Promise.all([
                putChatObject(key, processed.body, processed.contentType),
                thumbKey && processed.thumb
                    ? putChatObject(thumbKey, processed.thumb, "image/webp")
                    : Promise.resolve(),
            ]);

            const sent = await sendAttachment(
                viewerId,
                peerId,
                { key, thumbKey, processed },
                parsed.data.replyToId
            );

            // Saved: the files belong to the message now.
            uploadedKeys = [];

            await announceMessage(sent);

            return res.status(201).json({
                chatMessage: chatMessageFromSent(sent, true),
            });
        } catch (error) {
            // Unused files must not be left behind. A failed cleanup must not
            // throw either, or it would hide the real error.
            await deleteChatObjects(uploadedKeys).catch(() => {});
            return handleError(res, error, "Send attachment");
        } finally {
            if (file) {
                // Windows can hold the temp file for a moment (EBUSY). Retry a
                // few times, and never let a failed cleanup throw: the response
                // has usually been sent by now.
                await rm(file.path, {
                    force: true,
                    maxRetries: 5,
                    retryDelay: 100,
                }).catch((error) => {
                    console.warn("Could not remove temp upload:", error);
                });
            }
        }
    }
);

export default router;