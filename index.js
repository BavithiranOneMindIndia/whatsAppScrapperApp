// index.js
const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const os = require("os");

console.log("✅ Starting backend from:", __filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err);
});

// --- Directories (writable) ---
const ROOT = __dirname;
const BASE_DIR = path.join(os.homedir(), "whatsapp-exporter-sessions");
const SESSIONS_DIR = path.join(BASE_DIR, "exports");
const AUTH_DIR = path.join(BASE_DIR, "auth");
const CACHE_DIR = path.join(BASE_DIR, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "wwebjs-webcache.json"); // <-- after CACHE_DIR

// Ensure folders
[BASE_DIR, SESSIONS_DIR, AUTH_DIR, CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    console.log(`📁 Created directory: ${dir}`);
  }
});

// If the cache *path* is wrongly a directory from previous runs, clean it up.
try {
  if (fs.existsSync(CACHE_FILE)) {
    const st = fs.lstatSync(CACHE_FILE);
    if (st.isDirectory()) {
      console.warn("⚠️ Cache path is a directory, cleaning:", CACHE_FILE);
      fs.rmSync(CACHE_FILE, { recursive: true, force: true });
    }
  }
} catch (e) {
  console.error("❌ Failed checking cache path:", e);
}

// --- In-memory session store ---
const sessions = {};

// Health / ping / routes debug
app.get('/health', (req, res) => res.json({ status: "ok", sessions: Object.keys(sessions).length }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));
app.get('/debug/routes', (req, res) => {
  try {
    const stack = app._router?.stack || [];
    const routes = stack
      .filter(l => l.route && l.route.path)
      .map(l => ({ method: Object.keys(l.route.methods)[0]?.toUpperCase(), path: l.route.path }));
    res.json(routes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Custom Chrome (robust detection) ----
const CHROME_REL = ["chrome", "win64-139.0.7258.138", "chrome-win64", "chrome.exe"];

function findCustomChrome() {
  const candidates = [
    path.join(process.resourcesPath || __dirname, ...CHROME_REL),                   // correct (resources\chrome\…)
    path.join(process.resourcesPath || __dirname, "resources", ...CHROME_REL),      // if extraResources accidentally nested
    path.join(__dirname, "resources", ...CHROME_REL),                               // dev or unpacked next to code
    path.join(__dirname, "..", "resources", ...CHROME_REL)                          // some packagers
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { }
  }
  return null;
}

const customChromePath = process.platform === "win32" ? findCustomChrome() : null;
console.log("🔍 Custom Chrome resolved:", customChromePath || "(none)");

function puppeteerOptions() {
  const base = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-software-rasterizer"
    ]
  };
  if (customChromePath) {
    // Force puppeteer-core to use our binary
    process.env.PUPPETEER_EXECUTABLE_PATH = customChromePath;
    return { ...base, executablePath: customChromePath };
  }
  return base;
}

// Create a WhatsApp session
function createSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const sessionExportDir = path.join(SESSIONS_DIR, sessionId);
  const sessionAuthDir = path.join(AUTH_DIR, `session-${sessionId}`);
  [sessionExportDir, sessionAuthDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  });

  try {
    const client = new Client({
      puppeteer: puppeteerOptions(),
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: AUTH_DIR }),
      // Pin to local cached WhatsApp Web build for stability
      webVersionCache: { type: "local", path: CACHE_FILE }
      // If you ever need bleeding-edge temporarily: use { type: "none" }
    });

    sessions[sessionId] = { client, isReady: false, lastQr: null, error: null };

    client.on("qr", (qr) => {
      console.log(`📲 QR generated for ${sessionId}`);
      sessions[sessionId].lastQr = qr;
      sessions[sessionId].error = null;
    });

    client.on("ready", () => {
      console.log(`✅ ${sessionId} authenticated & ready`);
      sessions[sessionId].isReady = true;
      sessions[sessionId].error = null;
    });

    client.on("auth_failure", msg => {
      console.error(`❌ Auth failure for ${sessionId}:`, msg);
      sessions[sessionId].isReady = false;
      sessions[sessionId].error = `Authentication failed: ${msg}`;
    });

    client.on("disconnected", reason => {
      console.warn(`⚠️ ${sessionId} disconnected:`, reason);
      sessions[sessionId].isReady = false;
      sessions[sessionId].error = `Disconnected: ${reason}`;
    });

    client.on("error", error => {
      console.error(`❌ Client error for ${sessionId}:`, error);
      sessions[sessionId].error = error?.message || String(error);
    });

    client.initialize().catch(error => {
      console.error(`❌ Failed to initialize ${sessionId}:`, error);
      sessions[sessionId].error = error?.message || String(error);
    });

    return sessions[sessionId];

  } catch (error) {
    console.error(`❌ Error creating session ${sessionId}:`, error);
    sessions[sessionId] = { client: null, isReady: false, lastQr: null, error: error.message };
    return sessions[sessionId];
  }
}

// --- API Endpoints ---

// Create session
app.post("/session/create", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing session id" });
  if (sessions[id]) return res.json({ status: "exists", id, isReady: sessions[id].isReady, error: sessions[id].error });
  const session = createSession(id);
  res.json({ status: "created", id, error: session.error });
});

// Initialize session (load existing)
app.post("/session/:id/init", (req, res) => {
  const { id } = req.params;
  if (sessions[id]) return res.json({ status: "already_loaded", id, isReady: sessions[id].isReady, error: sessions[id].error });
  const session = createSession(id);
  res.json({ status: "loaded", id, error: session.error });
});

// Per-session status
app.get("/session/:id/status", (req, res) => {
  const { id } = req.params;
  const s = sessions[id];
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json({ id, isReady: s.isReady, error: s.error, hasQr: Boolean(s.lastQr) });
});

// Get QR
app.get("/session/:id/qr", async (req, res) => {
  const { id } = req.params;
  const s = sessions[id];
  if (!s) return res.status(404).json({ error: "Session not found" });
  if (s.error) return res.status(500).json({ error: s.error });
  if (s.isReady) return res.json({ status: "authenticated" });
  if (!s.lastQr) return res.json({ status: "pending", message: "QR not yet available" });

  try {
    const qrDataUrl = await qrcode.toDataURL(s.lastQr);
    res.json({ status: "not_authenticated", qr: qrDataUrl });
  } catch (error) {
    console.error(`❌ QR generation error for ${id}:`, error);
    res.status(500).json({ error: "Failed to generate QR code" });
  }
});

// List sessions (API) — ensure BEFORE static
app.get("/api/sessions", (req, res) => {
  const discovered = [];
  try {
    if (fs.existsSync(AUTH_DIR)) {
      const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith("session-")) {
          const id = e.name.replace(/^session-/, "");
          if (!sessions[id]) discovered.push({ id, isReady: false, known: false, error: null });
          else discovered.push({ id, isReady: sessions[id].isReady, known: true, error: sessions[id].error });
        }
      }
    }
  } catch (error) {
    console.error("❌ Error reading sessions directory:", error);
  }

  const mem = Object.keys(sessions).map(id => ({
    id, isReady: sessions[id].isReady, known: true, error: sessions[id].error
  }));
  const merged = {};
  for (const item of [...mem, ...discovered]) merged[item.id] = item;
  res.json(Object.values(merged));
});

// Export groups
app.post("/session/:id/run-groups", async (req, res) => {
  const { id } = req.params;
  const s = sessions[id];
  if (!s) return res.status(404).json({ error: "Session not loaded" });
  if (s.error) return res.status(500).json({ error: s.error });
  if (!s.isReady) return res.status(401).json({ error: "Session not authenticated" });

  try {
    const chats = await s.client.getChats();
    const groups = chats.filter(c => c.isGroup);
    const groupData = {};

    for (const g of groups) {
      try {
        const full = await s.client.getChatById(g.id._serialized);
        const participants = (full.participants || []).map(p =>
          String(p.id?._serialized || "")
            .replace("@c.us", "")
            .replace("@s.whatsapp.net", "")
        );
        const groupName = full.name || g.name || g.id._serialized;
        groupData[groupName] = participants;
      } catch (e) {
        console.warn("Failed to load participants for", g.id?._serialized, e?.message);
        groupData[g.name || g.id._serialized] = [];
      }
    }

    const excelRows = Object.entries(groupData).map(([groupName, participants]) => ({
      "Group Name": groupName,
      "Participants": participants.join(", ")
    }));
    const ws = XLSX.utils.json_to_sheet(excelRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Groups");

    const outDir = path.join(SESSIONS_DIR, id);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, "groups_participants.xlsx");
    XLSX.writeFile(wb, outFile);

    const totalParticipants = Object.values(groupData).reduce((acc, arr) => acc + arr.length, 0);
    const publicUrl = `http://127.0.0.1:${PORT}/sessions/${encodeURIComponent(id)}/groups_participants.xlsx`;

    res.json({ status: "success", file: publicUrl, groups: Object.keys(groupData).length, totalParticipants });
  } catch (err) {
    console.error("❌ Error exporting groups:", err);
    res.status(500).json({ error: `Failed to export groups: ${err.message}` });
  }
});

// Latest Excel link
app.get("/session/:id/result", (req, res) => {
  const { id } = req.params;
  const filePath = path.join(SESSIONS_DIR, id, "groups_participants.xlsx");

  if (fs.existsSync(filePath)) {
    const fullUrl = `http://127.0.0.1:${PORT}/sessions/${encodeURIComponent(id)}/groups_participants.xlsx`;
    res.json({ exists: true, file: fullUrl });
  } else {
    res.json({ exists: false, file: null });
  }
});

// Unique participants (across all sessions)
app.post("/unique-participants", async (req, res) => {
  try {
    const allParticipants = new Set();
    let processedFiles = 0;
    if (!fs.existsSync(SESSIONS_DIR)) return res.status(404).json({ error: "No sessions directory found" });

    const sessionDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(SESSIONS_DIR, d.name));

    for (const folder of sessionDirs) {
      const filePath = path.join(folder, "groups_participants.xlsx");
      if (!fs.existsSync(filePath)) continue;
      try {
        const wb = XLSX.readFile(filePath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);
        rows.forEach(row => {
          if (row.Participants) {
            row.Participants.split(',')
              .map(p => p.trim())
              .filter(p => p)
              .forEach(p => allParticipants.add(p));
          }
        });
        processedFiles++;
      } catch (error) {
        console.error(`❌ Error processing file ${filePath}:`, error);
      }
    }

    if (processedFiles === 0) return res.status(404).json({ error: "No valid group files found" });

    const resultRows = Array.from(allParticipants).sort().map(p => ({ Participant: p }));
    const wsOut = XLSX.utils.json_to_sheet(resultRows);
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, wsOut, "UniqueParticipants");

    const outFile = path.join(SESSIONS_DIR, "unique_participants.xlsx");
    XLSX.writeFile(wbOut, outFile);

    const publicUrl = `http://127.0.0.1:${PORT}/sessions/unique_participants.xlsx`;
    res.json({ status: "success", count: allParticipants.size, file: publicUrl, processedFiles });
  } catch (err) {
    console.error("❌ Error generating unique participants:", err);
    res.status(500).json({ error: `Failed to generate unique participants: ${err.message}` });
  }
});

app.post("/webcache/reset", (req, res) => {
  try {
    let deleted = false;
    if (fs.existsSync(CACHE_FILE)) {
      const st = fs.lstatSync(CACHE_FILE);
      if (st.isDirectory()) {
        // Clean directory if someone created it with that name
        fs.rmSync(CACHE_FILE, { recursive: true, force: true });
        deleted = true;
      } else {
        // Regular file
        fs.unlinkSync(CACHE_FILE);
        deleted = true;
      }
    }
    // Make sure cache dir still exists for future writes
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o755 });

    res.json({
      status: "success",
      deleted,
      message: deleted ? "Cache removed. Load/create a session to repin a fresh build." : "No cache file found."
    });
  } catch (e) {
    console.error("❌ Failed to reset web cache:", e);
    res.status(500).json({
      error: "Failed to reset web cache",
      details: e.message
    });
  }
});

app.get("/webcache/status", (req, res) => {
  try {
    if (!fs.existsSync(CACHE_FILE)) return res.json({ exists: false });
    const stat = fs.statSync(CACHE_FILE);
    res.json({ exists: true, size: stat.size, mtime: stat.mtime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static files AFTER API
app.use("/sessions", express.static(SESSIONS_DIR));

// JSON 404 (avoid HTML)
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// Start server
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Backend running at http://127.0.0.1:${PORT}`);
  console.log(`📁 Sessions: ${SESSIONS_DIR}`);
  console.log(`🔐 Auth: ${AUTH_DIR}`);
});
server.on('error', (e) => console.error('❌ app.listen error:', e));
