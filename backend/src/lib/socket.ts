import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Request, Response } from "express";
import { inArray } from "drizzle-orm";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import { db } from "../db/index.js";
import { profiles } from "../db/schema.js";
import { HttpError } from "./http.js";
import {
    findPeer,
    messageBodySchema,
    sendMessage,
    type SentMessage,
} from "./chat.js";
import { sessionMiddleware, sessionStore } from "./session.js";
import { usernameSchema } from "./username.js";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const WS_PATH = "/ws";

// 2000 characters can be 8000 bytes (4 bytes each for emoji) plus the JSON
// envelope. A bigger frame closes the connection (ws does it automatically).
const MAX_PAYLOAD_BYTES = 16 * 1024;

// Open tabs per user.
const MAX_SOCKETS_PER_USER = 5;

const HEARTBEAT_MS = 30 * 1000;

// A socket outlives the HTTP request that authenticated it, so a sign-out or an
// expired session has to close it. Checked on the heartbeat, at most this often.
const SESSION_RECHECK_MS = 60 * 1000;

// Per user (all tabs together). Separate budget from the REST route.
const SEND_LIMIT = 60;
const SEND_WINDOW_MS = 60 * 1000;

function allowedOrigin(): string {
    return process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
}

/* ------------------------------------------------------------------ */
/* Protocol                                                            */
/* ------------------------------------------------------------------ */

// Client -> server (JSON text frames). Only one event for now.
//   { type: "send", username, body, clientId? }
//
// Server -> client:
//   { type: "ready" }                                  connected and authenticated
//   { type: "ack", clientId, id }                      your send was saved (only to the socket that sent it)
//   { type: "message", username, chatMessage }         a message in the thread with `username`,
//                                                      sent to ALL of the sender's and recipient's sockets;
//                                                      chatMessage = { id, body, createdAt, fromMe }
//   { type: "error", status, message, clientId? }      something was rejected
//
// Clients dedupe by chatMessage.id (the sender's own socket gets ack and message).
const clientEventSchema = z.object({
    type: z.literal("send"),
    clientId: z.string().max(64).optional(),
    username: usernameSchema,
    body: messageBodySchema,
});

/* ------------------------------------------------------------------ */
/* State (single server instance; see the pub/sub note below)          */
/* ------------------------------------------------------------------ */

// The sender is decided by the server: userId comes from the session cookie
// during the upgrade, never from anything the client sends.
type ChatSocket = WebSocket & {
    userId: number;
    sessionId: string;
    isAlive: boolean;
    lastSessionCheck: number;
    queue: Promise<void>; // handles one event at a time, so a user's messages keep their order
};

// With more than one server instance this map only knows its own sockets, and
// delivery would need pub/sub (Redis or Postgres LISTEN/NOTIFY).
const connections = new Map<number, Set<ChatSocket>>();
const sendTimes = new Map<number, number[]>();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(socket: WebSocket, payload: unknown) {
    if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function sendError(
    socket: WebSocket,
    status: number,
    message: string,
    clientId?: string
) {
    sendJson(socket, { type: "error", status, message, clientId });
}

// Push an event to every open tab of one user. Also the hook for future events
// (for example "relationship changed" after accept or unfriend).
export function pushToUser(userId: number, payload: unknown) {
    for (const socket of connections.get(userId) ?? []) {
        sendJson(socket, payload);
    }
}

// Sliding window per user: at most SEND_LIMIT sends in SEND_WINDOW_MS.
function allowSend(userId: number): boolean {
    const now = Date.now();
    const recent = (sendTimes.get(userId) ?? []).filter(
        (time) => now - time < SEND_WINDOW_MS
    );

    if (recent.length >= SEND_LIMIT) {
        sendTimes.set(userId, recent);
        return false;
    }

    recent.push(now);
    sendTimes.set(userId, recent);
    return true;
}

function readClientId(json: unknown): string | undefined {
    if (typeof json === "object" && json !== null && "clientId" in json) {
        const value = (json as { clientId: unknown }).clientId;
        return typeof value === "string" ? value.slice(0, 64) : undefined;
    }

    return undefined;
}

// Tells both people about a saved message, on every tab they have open. Used by
// the socket handler and by POST /api/messages, so a REST send is delivered live
// too. Never throws: the message is already saved, so a failed push must not
// turn into a failed send.
export async function announceMessage(sent: SentMessage): Promise<void> {
    try {
        const rows = await db
            .select({ userId: profiles.userId, username: profiles.username })
            .from(profiles)
            .where(inArray(profiles.userId, [sent.senderId, sent.recipientId]));

        const senderName = rows.find((row) => row.userId === sent.senderId)?.username;
        const recipientName = rows.find(
            (row) => row.userId === sent.recipientId
        )?.username;

        if (!senderName || !recipientName) {
            return;
        }

        const base = { id: sent.id, body: sent.body, createdAt: sent.createdAt };

        // Each side sees the thread under the other person's username.
        pushToUser(sent.senderId, {
            type: "message",
            username: recipientName,
            chatMessage: { ...base, fromMe: true },
        });
        pushToUser(sent.recipientId, {
            type: "message",
            username: senderName,
            chatMessage: { ...base, fromMe: false },
        });
    } catch (error) {
        console.error("Announce message error:", error);
    }
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

// Runs the same express-session middleware the HTTP routes use, on the upgrade
// request, so the socket is authenticated by the existing sync.sid cookie. The
// response is a stub: the session is only read, never written, so no cookie is
// set and the session expiry is not extended by the socket.
function authenticate(
    req: IncomingMessage
): Promise<{ userId: number; sessionId: string } | null> {
    return new Promise((resolve) => {
        const request = req as Request;

        sessionMiddleware(request, {} as Response, (error?: unknown) => {
            if (error) {
                console.error("Socket session error:", error);
            }

            const userId = request.session?.userId;

            resolve(
                userId === undefined
                    ? null
                    : { userId, sessionId: request.sessionID }
            );
        });
    });
}

function loadSession(sessionId: string): Promise<{ userId?: number } | null> {
    return new Promise((resolve, reject) => {
        sessionStore.get(sessionId, (error, session) => {
            if (error) {
                reject(error);
                return;
            }

            resolve((session as { userId?: number } | null | undefined) ?? null);
        });
    });
}

// Closes the socket if its session was destroyed (sign-out, expiry) or now
// belongs to someone else. A store error leaves the socket alone: a database
// blip should not log everyone out.
async function recheckSession(socket: ChatSocket) {
    try {
        const session = await loadSession(socket.sessionId);

        if (!session || session.userId !== socket.userId) {
            socket.close(4401, "Signed out");
        }
    } catch (error) {
        console.error("Socket session recheck error:", error);
    }
}

/* ------------------------------------------------------------------ */
/* Handling events                                                     */
/* ------------------------------------------------------------------ */

async function handleMessage(socket: ChatSocket, data: RawData, isBinary: boolean) {
    if (isBinary) {
        sendError(socket, 400, "Only text messages are supported");
        return;
    }

    let json: unknown;

    try {
        json = JSON.parse(data.toString());
    } catch {
        sendError(socket, 400, "Messages must be valid JSON");
        return;
    }

    const clientId = readClientId(json);
    const parsed = clientEventSchema.safeParse(json);

    if (!parsed.success) {
        sendError(
            socket,
            400,
            parsed.error.issues[0]?.message ?? "Invalid message",
            clientId
        );
        return;
    }

    if (!allowSend(socket.userId)) {
        sendError(
            socket,
            429,
            "You are sending messages too fast. Slow down.",
            clientId
        );
        return;
    }

    try {
        const peerId = await findPeer(socket.userId, parsed.data.username);
        const sent = await sendMessage(socket.userId, peerId, parsed.data.body);

        // Ack first so the sender's optimistic message gets its id before the
        // "message" event for the same id arrives.
        sendJson(socket, { type: "ack", clientId, id: sent.id });
        await announceMessage(sent);
    } catch (error) {
        if (error instanceof HttpError) {
            sendError(socket, error.status, error.message, clientId);
            return;
        }

        console.error("Chat socket send error:", error);
        sendError(socket, 500, "Could not send message", clientId);
    }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function rejectUpgrade(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

// Attach to the HTTP server that app.listen() returns. Only /ws is handled.
export function attachChatSocket(server: Server) {
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_PAYLOAD_BYTES,
    });

    function onConnection(
        ws: WebSocket,
        auth: { userId: number; sessionId: string }
    ) {
        const socket = Object.assign(ws, {
            userId: auth.userId,
            sessionId: auth.sessionId,
            isAlive: true,
            lastSessionCheck: Date.now(),
            queue: Promise.resolve(),
        }) as ChatSocket;

        const sockets = connections.get(socket.userId) ?? new Set<ChatSocket>();
        sockets.add(socket);
        connections.set(socket.userId, sockets);

        socket.on("pong", () => {
            socket.isAlive = true;
        });

        socket.on("message", (data, isBinary) => {
            socket.queue = socket.queue
                .then(() => handleMessage(socket, data, isBinary))
                .catch((error) => console.error("Chat socket error:", error));
        });

        socket.on("close", () => {
            sockets.delete(socket);

            if (sockets.size === 0) {
                connections.delete(socket.userId);
            }
        });

        // Without an error listener, a network error would crash the process.
        socket.on("error", (error) => console.error("Chat socket error:", error));

        sendJson(socket, { type: "ready" });
    }

    async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
        console.log("upgrade request:", req.url, "origin:", req.headers.origin)
        try {
            const { pathname } = new URL(req.url ?? "/", "http://localhost");

            if (pathname !== WS_PATH) {
                socket.destroy();
                return;
            }

            // Browsers always send Origin on a WebSocket handshake, and cookies go
            // with it, so a page on another site could otherwise use a signed-in
            // user's session. Anything that is not our frontend is refused.
            if (req.headers.origin !== allowedOrigin()) {
                rejectUpgrade(socket, 403, "Forbidden");
                return;
            }

            const auth = await authenticate(req);

            if (!auth) {
                rejectUpgrade(socket, 401, "Unauthorized");
                return;
            }

            if ((connections.get(auth.userId)?.size ?? 0) >= MAX_SOCKETS_PER_USER) {
                rejectUpgrade(socket, 429, "Too Many Requests");
                return;
            }

            wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth));
        } catch (error) {
            console.error("Socket upgrade error:", error);
            rejectUpgrade(socket, 500, "Internal Server Error");
        }
    }

    server.on("upgrade", (req, socket, head) => {
        void handleUpgrade(req, socket, head);
    });

    // Heartbeat: a socket that did not answer the last ping is dead (closed
    // laptop, dropped network) and is terminated; the rest are pinged again.
    const heartbeat = setInterval(() => {
        const now = Date.now();

        for (const client of wss.clients) {
            const socket = client as ChatSocket;

            if (!socket.isAlive) {
                socket.terminate();
                continue;
            }

            socket.isAlive = false;
            socket.ping();

            if (now - socket.lastSessionCheck >= SESSION_RECHECK_MS) {
                socket.lastSessionCheck = now;
                void recheckSession(socket);
            }
        }

        // Forget rate-limit entries nobody has used lately.
        for (const [userId, times] of sendTimes) {
            if (times.every((time) => now - time >= SEND_WINDOW_MS)) {
                sendTimes.delete(userId);
            }
        }
    }, HEARTBEAT_MS);

    wss.on("close", () => clearInterval(heartbeat));
}