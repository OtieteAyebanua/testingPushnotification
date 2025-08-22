// index.js
const express = require("express");
const { MongoClient } = require("mongodb");

// ===== Inline secrets (as you requested) =====
const MONGODB_URI =
  "mongodb+srv://ayebanua:Hwj8DxoE4R8ucQzW@cluster0.lenfah1.mongodb.net/";
const DB_NAME = "testingPushNotification"; // <- your db name
const COLLECTION_NAME = "dataset"; // <- your collection name

const client = new MongoClient(MONGODB_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
});

let db;
async function connectDB() {
  if (db) return db;
  await client.connect();
  db = client.db(DB_NAME);
  console.log("✅ MongoDB connected:", db.databaseName);
  await db
    .collection(COLLECTION_NAME)
    .createIndex({ token: 1 }, { unique: true });
  return db;
}

async function closeDB() {
  try {
    await client.close();
  } catch {}
}

// ===== Robust process diagnostics =====
process.on("uncaughtException", (e) => {
  console.error("💥 uncaughtException:", e);
});
process.on("unhandledRejection", (e) => {
  console.error("💥 unhandledRejection:", e);
});
process.on("beforeExit", (code) => {
  console.warn("⚠️  beforeExit:", code, "(event loop about to empty)");
});
process.on("exit", (code) => {
  console.warn("⚠️  exit:", code);
});
process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received, shutting down...");
  await closeDB();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received, shutting down...");
  await closeDB();
  process.exit(0);
});

const app = express();
app.use(express.json());

// Minimal route to prove server is alive
app.get("/", (_req, res) => res.send("OK"));

// Save token safely (body or query)
app.post("/save", async (req, res) => {
  try {
    const { token, name = null } = req.body?.token ? req.body : req.query;
    if (!token) return res.status(400).json({ message: "token required" });

    const db = await connectDB();
    const col = db.collection(COLLECTION_NAME);

    const r = await col.updateOne(
      { token },
      {
        $set: { token, name, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    res.json({ message: "✅ saved", upserted: !!r.upsertedId });
  } catch (e) {
    console.error("save error:", e);
    res.status(500).json({ message: "❌ save failed" });
  }
});

// ===== Start the server with explicit error hooks =====
(async () => {
  try {
    // Optional: connect first so startup fails fast if DB is unreachable
    await connectDB();

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`🗄️  Using DB="${DB_NAME}", Collection="${COLLECTION_NAME}"`);
    });

    server.on("error", (err) => {
      console.error("💥 server error:", err);
      // Keep process alive long enough to see the log
      setTimeout(() => process.exit(1), 50);
    });
  } catch (e) {
    console.error("💥 Startup error:", e);
    process.exit(1);
  }
})();

//........................................

// ===== Expo Push (ping all tokens every 5s) =====
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// If Node doesn't have global fetch (older versions), lazy-load node-fetch
let _fetch = global.fetch;
if (typeof _fetch !== "function") {
  _fetch = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}

// Customize the payload sent to devices here:
const DEFAULT_TYPE = "ping";
const DEFAULT_ID = "auto-5s";
const DEFAULT_TITLE = "Hello 👋";
const DEFAULT_BODY = "Automated ping from server";

/**
 * Send one push to a single Expo token.
 * Sends { type, id } in the `data` object as requested.
 */
async function sendExpoNotification(toToken, { type, id }) {
  const payload = {
    to: toToken,
    sound: "default",
    title: DEFAULT_TITLE,
    body: DEFAULT_BODY,
    data: { type, id }, // <= your requested object
  };

  const resp = await _fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Expo push failed (${resp.status}): ${text}`);
  }

  // Expo returns a receipt (ticket) object
  return resp.json();
}

/**
 * Read all tokens from Mongo and ping each one.
 * Sequential loop to keep things simple and avoid rate spikes.
 */
async function pushAllTokens() {
  try {
    const db = await connectDB();
    const col = db.collection(COLLECTION_NAME);

    // Only need token field
    const tokens = await col
      .find({}, { projection: { token: 1, _id: 0 } })
      .toArray();

    if (!tokens.length) {
      // Nothing to send yet
      return;
    }

    for (const { token } of tokens) {
      try {
        const receipt = await sendExpoNotification(token, {
          type: DEFAULT_TYPE,
          id: DEFAULT_ID,
        });
        console.log("📨 Sent =>", token, JSON.stringify(receipt));
      } catch (err) {
        console.error("❌ Push error for", token, "-", err.message);
      }
    }
  } catch (err) {
    console.error("❌ pushAllTokens error:", err.message);
  }
}

// Run every 5 seconds
setInterval(pushAllTokens, 5000);
