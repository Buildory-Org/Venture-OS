import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { ensureIndexes } from "./indexes.js";
import { createAuth } from "./auth.js";
import { createObjectStore } from "./storage.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./collaboration.js";

const envFile = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find(existsSync);
if (envFile) process.loadEnvFile(envFile);
const config = loadConfig();
const database = await connectDatabase(config);
await ensureIndexes(database.db);
const auth = createAuth(database.native, config);
const store = createObjectStore(config);
const { app, resolveActor } = createApp(database, config, auth, store);
const server = createServer(app);
attachRealtime(server, database, resolveActor, config.APP_ORIGIN, config.APP_MODE === "local" && config.ALLOW_DEV_AUTH);
server.listen(config.PORT, () => console.info(JSON.stringify({ level: "info", event: "api.started", port: config.PORT, mode: config.APP_MODE, transactions: database.transactions, storage: store.kind })));
async function shutdown() { server.close(); await database.client.close(); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
