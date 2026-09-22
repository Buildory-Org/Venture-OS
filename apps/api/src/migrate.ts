import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { ensureIndexes } from "./indexes.js";

const config = loadConfig();
const database = await connectDatabase(config);
try {
  await ensureIndexes(database.db);
  await database.db.collection("migrations").updateOne(
    { _id: "001-initial-indexes" },
    { $setOnInsert: { appliedAt: new Date() } },
    { upsert: true },
  );
  console.info("Migration 001-initial-indexes applied");
} finally {
  await database.client.close();
}
