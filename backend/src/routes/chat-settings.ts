import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth.js";
import { handleError, validationError } from "../lib/http.js";
import { findPeer } from "../lib/chat.js";
import { listPins, setPinned } from "../lib/chat-pins.js";
import { listStars, setStarred } from "../lib/chat-stars.js";
import { announcePin, announceStar } from "../lib/socket.js";

// Per-chat actions that are not sending or reading messages: pins and stars now;
// disappearing messages are added to this file in the next step.
const router = Router();

const messageIdSchema = z.object({
    id: z.coerce.number().int().positive(),
});

// Pinning is cheap but not free. Per user, all chats together.
const actionLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "You are doing that too fast. Slow down." },
});

/* ------------------------------------------------------------------ */
/* Pin                                                                 */
/* ------------------------------------------------------------------ */

// Pin a message. Shared: both people see it and either can unpin. At most 3 per
// chat (409 when full). Pinning something already pinned is a success.
router.post("/messages/:id/pin", requireAuth, actionLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = messageIdSchema.safeParse(req.params);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const { peerId, changed } = await setPinned(viewerId, parsed.data.id, true);

        if (changed) {
            await announcePin({
                messageId: parsed.data.id,
                pinned: true,
                viewerId,
                peerId,
            });
        }

        return res.json({ message: "Message pinned" });
    } catch (error) {
        return handleError(res, error, "Pin message");
    }
});

// Unpin a message. Either person can unpin any pin. Idempotent.
router.delete("/messages/:id/pin", requireAuth, actionLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = messageIdSchema.safeParse(req.params);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const { peerId, changed } = await setPinned(viewerId, parsed.data.id, false);

        if (changed) {
            await announcePin({
                messageId: parsed.data.id,
                pinned: false,
                viewerId,
                peerId,
            });
        }

        return res.json({ message: "Message unpinned" });
    } catch (error) {
        return handleError(res, error, "Unpin message");
    }
});

// The pins of one thread, newest pin first. No pins is an empty list.
router.get("/conversations/:username/pins", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const peerId = await findPeer(viewerId, req.params.username);
        const pins = await listPins(viewerId, peerId);

        return res.json({ pins });
    } catch (error) {
        return handleError(res, error, "List pins");
    }
});

/* ------------------------------------------------------------------ */
/* Star                                                                */
/* ------------------------------------------------------------------ */

// Star a message. Private: only I see it. Starring twice is a success.
router.post("/messages/:id/star", requireAuth, actionLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = messageIdSchema.safeParse(req.params);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const { peerId, changed } = await setStarred(viewerId, parsed.data.id, true);

        if (changed) {
            await announceStar({
                messageId: parsed.data.id,
                starred: true,
                viewerId,
                peerId,
            });
        }

        return res.json({ message: "Message starred" });
    } catch (error) {
        return handleError(res, error, "Star message");
    }
});

// Unstar a message. Idempotent.
router.delete("/messages/:id/star", requireAuth, actionLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = messageIdSchema.safeParse(req.params);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const { peerId, changed } = await setStarred(viewerId, parsed.data.id, false);

        if (changed) {
            await announceStar({
                messageId: parsed.data.id,
                starred: false,
                viewerId,
                peerId,
            });
        }

        return res.json({ message: "Message unstarred" });
    } catch (error) {
        return handleError(res, error, "Unstar message");
    }
});

// My starred messages in one thread, newest star first (for the Chat info
// panel). No stars is an empty list.
router.get("/conversations/:username/stars", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const peerId = await findPeer(viewerId, req.params.username);
        const stars = await listStars(viewerId, peerId);

        return res.json({ stars });
    } catch (error) {
        return handleError(res, error, "List stars");
    }
});

export default router;
