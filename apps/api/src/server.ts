import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { ensureIndexes } from "./indexes.js";
import { createAuth } from "./auth.js";
import { createObjectStore } from "./storage.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./collaboration.js";

const config = loadConfig();
const database = await connectDatabase(config);
await ensureIndexes(database.db);
const auth = createAuth(database.native, config);
const store = createObjectStore(config);
const { app, resolveActor } = createApp(database, config, auth, store);
const server = createServer(app);
attachRealtime(server, database, resolveActor, config.APP_ORIGIN);
server.listen(config.PORT, () => console.info(JSON.stringify({ level: "info", event: "api.started", port: config.PORT, mode: config.APP_MODE, transactions: database.transactions, storage: store.kind })));
async function shutdown() { server.close(); await database.client.close(); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
