import app from "./app.js";
import { attachChatSocket } from "./lib/socket.js";

const port = Number(process.env.PORT ?? 6000);

const server= app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});

attachChatSocket(server);