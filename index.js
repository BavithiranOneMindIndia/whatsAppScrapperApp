const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- Folders ---
const ROOT = __dirname;
const SESSIONS_DIR = path.join(ROOT, "sessions");        // Excel exports per session
const AUTH_DIR = path.join(ROOT, "sessions_auth");       // WhatsApp auth per session
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

app.get('/', (req, res) => res.send('API Running'));

app.listen(PORT, () => console.log(`Express running on http://localhost:${PORT}`));

// Serve exported files statically so UI can download
app.use("/sessions", express.static(SESSIONS_DIR));

// Optional: custom Chrome if you ship one with app
const customChrome = path.join(ROOT, "chrome", "win64-139.0.7258.68", "chrome-win64", "chrome.exe");
const hasCustomChrome = fs.existsSync(customChrome);

function puppeteerOptions() {
  const base = { headless: false, args: ["--start-maximized"] };
  return hasCustomChrome ? { ...base, executablePath: customChrome } : base;
}

// --- Multi-session store ---
/**
 * sessions: {
 *   [sessionId]: {
 *      client: Client,
 *      isReady: boolean,
 *      lastQr: string | null
 *   }
 * }
 */
const sessions = {};

// Create a new WhatsApp session
function createSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const sessionExportDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionExportDir)) fs.mkdirSync(sessionExportDir, { recursive: true });

  const client = new Client({
    puppeteer: puppeteerOptions(),
    authStrategy: new LocalAuth({
      clientId: sessionId,          // unique per session
      dataPath: AUTH_DIR            // auth data stored under sessions_auth/
    })
  });

  sessions[sessionId] = {
    client,
    isReady: false,
    lastQr: null
  };

  client.on("qr", (qr) => {
    console.log(`📲 QR generated for ${sessionId}`);
    sessions[sessionId].lastQr = qr;
  });

  client.on("ready", () => {
    console.log(`✅ ${sessionId} authenticated & ready`);
    sessions[sessionId].isReady = true;
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ Auth failure for ${sessionId}:`, msg);
    sessions[sessionId].isReady = false;
  });

  client.on("disconnected", (reason) => {
    console.warn(`⚠️ ${sessionId} disconnected:`, reason);
    sessions[sessionId].isReady = false;
    // Keep client in memory; user may re-open app and it will reconnect.
  });

  client.initialize();
  return sessions[sessionId];
}

// --- API ---

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", sessions: Object.keys(sessions).length });
});

// Create session (or no-op if exists)
app.post("/session/create", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing session id" });

  if (sessions[id]) {
    return res.json({ status: "exists", id, isReady: sessions[id].isReady });
  }

  createSession(id);
  res.json({ status: "created", id });
});

// Get QR for a session
app.get("/session/:id/qr", async (req, res) => {
  const { id } = req.params;
  const s = sessions[id];
  if (!s) return res.status(404).json({ error: "Session not found" });

  if (s.isReady) return res.json({ status: "authenticated" });

  if (!s.lastQr) {
    return res.json({ status: "pending", message: "QR not yet available. Keep polling." });
  }

  const qrDataUrl = await qrcode.toDataURL(s.lastQr);
  res.json({ status: "not_authenticated", qr: qrDataUrl });
});

// List sessions (in-memory ones + inferred from auth dir)
app.get("/sessions", (req, res) => {
  // discover any previously authenticated sessions by scanning AUTH_DIR
  const discovered = [];
  try {
    const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith("session-")) {
        const id = e.name.replace(/^session-/, "");
        // ensure it's present in memory map too
        if (!sessions[id]) {
          // don't initialize yet (lazy). show as "known=false" until user opens it.
          discovered.push({ id, isReady: false, known: false });
        } else {
          discovered.push({ id, isReady: sessions[id].isReady, known: true });
        }
      }
    }
  } catch (_) { }

  // Add all in-memory sessions
  const mem = Object.keys(sessions).map((id) => ({
    id,
    isReady: sessions[id].isReady,
    known: true
  }));

  // merge unique by id (prefer in-memory record)
  const merged = {};
  for (const item of [...mem, ...discovered]) merged[item.id] = item;

  res.json(Object.values(merged));
});

// Initialize (load) an existing session into memory without re-scanning QR
app.post("/session/:id/init", (req, res) => {
  const { id } = req.params;
  if (sessions[id]) {
    return res.json({ status: "already_loaded", id, isReady: sessions[id].isReady });
  }
  // This will use stored auth (if present) and auto-login
  createSession(id);
  res.json({ status: "loaded", id });
});

// Run groups export for a session (overwrites Excel)
app.post("/session/:id/run-groups", async (req, res) => {
  const { id } = req.params;
  const s = sessions[id];
  if (!s) return res.status(404).json({ error: "Session not loaded. Click 'Load' or 'Create' first." });
  if (!s.isReady) return res.status(401).json({ error: "Session not authenticated. Scan QR first." });

  try {
    const chats = await s.client.getChats();
    const groups = chats.filter((c) => c.isGroup);

    const groupData = {};
    for (let g of groups) {
      const participants = g.participants.map((p) =>
        p.id._serialized.replace("@c.us", "")
      );
      groupData[g.name] = participants;
    }

    // Prepare Excel rows
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

    res.json({
      status: "success",
      file: `/sessions/${encodeURIComponent(id)}/groups_participants.xlsx`
    });
  } catch (err) {
    console.error("❌ Error exporting groups:", err);
    res.status(500).json({ error: "Failed to export groups" });
  }
});

// Get latest result for a session (if exists)
app.get("/session/:id/result", (req, res) => {
  const { id } = req.params;
  const outFile = path.join(SESSIONS_DIR, id, "groups_participants.xlsx");
  const exists = fs.existsSync(outFile);
  res.json({
    exists,
    file: exists ? `/sessions/${encodeURIComponent(id)}/groups_participants.xlsx` : null
  });
});

app.post("/unique-participants", async (req, res) => {
  try {
    const allParticipants = new Set();

    const sessionDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(SESSIONS_DIR, d.name));

    for (const folder of sessionDirs) {
      const filePath = path.join(folder, "groups_participants.xlsx");
      if (!fs.existsSync(filePath)) continue;

      const wb = XLSX.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws);

      for (const row of rows) {
        if (!row.Participants) continue;
        const parts = row.Participants.split(',').map(p => p.trim()).filter(p => p);
        parts.forEach(p => allParticipants.add(p));
      }
    }

    // Save result
    const resultRows = Array.from(allParticipants).map(p => ({ Participant: p }));
    const wsOut = XLSX.utils.json_to_sheet(resultRows);
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, wsOut, "UniqueParticipants");

    const outFile = path.join(SESSIONS_DIR, "unique_participants.xlsx");
    XLSX.writeFile(wbOut, outFile);

    res.json({ status: "success", count: allParticipants.size, file: `/sessions/unique_participants.xlsx` });
  } catch (err) {
    console.error("❌ Error generating unique participants:", err);
    res.status(500).json({ error: "Failed to generate unique participants" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
