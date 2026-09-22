import { MongoClient } from "mongodb";
import { loadConfig } from "./config.js";
import { Worker } from "./worker.js";

const config = loadConfig();
const client = new MongoClient(config.MONGODB_URI);
await client.connect();
const db = client.db(config.MONGODB_DB);
const hello = await db.admin().command({ hello: 1 });
const transactions = typeof hello.setName === "string";
if (config.APP_MODE === "production" && !transactions) throw new Error("Production worker requires a MongoDB replica set");
const worker = new Worker(client, db, config, transactions);
let stopping = false;
process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
while (!stopping) {
  try {
    const worked = await worker.tick();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, config.POLL_MS));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "worker.tick.failed", error: error instanceof Error ? error.message : "unknown" }));
    await new Promise((resolve) => setTimeout(resolve, config.POLL_MS));
  }
}
await client.close();
