import app from "./app.js";
import { startRetentionWorker } from "./lib/retention.js";
import { attachChatSocket } from "./lib/socket.js";

const port = Number(process.env.PORT ?? 6000);

const server= app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});

attachChatSocket(server);

// Wipes the content of expired and long-deleted messages in the background.
const stopRetention = startRetentionWorker();

server.on("close", stopRetention);
