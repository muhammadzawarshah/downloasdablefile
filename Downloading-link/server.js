// Dispatch — tiny file-sharing server
// Upload any file  ->  get a public download link  ->  friend clicks  ->  file downloads.
// Every download is logged (time, device, location) and readable at /admin.

const express = require("express");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const crypto  = require("crypto");
const device  = require("./device");

// Load .env when present so a local run gets the same config as the deployment.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* no .env — env vars come from the platform */ }

let blobApi = null;
if (process.env.BLOB_READ_WRITE_TOKEN) {
  blobApi = require("@vercel/blob");
}

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const MAX_MB = Number(process.env.MAX_MB || 250);
const USE_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// On Vercel the deployment root is a read-only filesystem (EROFS); only /tmp is
// writable, and it is wiped between invocations. So never write inside ROOT_DIR
// there — Blob storage is the real backend in that case.
const READ_ONLY_ROOT = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
// Deployed with no Blob store: uploads land in /tmp, which belongs to one
// function instance and is discarded when that instance is recycled — the file
// 404s minutes later. Never silently accept an upload in this state.
const EPHEMERAL = READ_ONLY_ROOT && !USE_BLOB;
const WRITABLE_DIR = READ_ONLY_ROOT ? path.join(os.tmpdir(), "dispatch") : ROOT_DIR;
const LOCAL_UPLOAD_DIR = path.join(WRITABLE_DIR, "uploads");
const LOCAL_DATA_FILE = path.join(WRITABLE_DIR, "files.json");
const LOCAL_LOG_FILE = path.join(WRITABLE_DIR, "downloads.log");

if (!USE_BLOB) {
  try {
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.warn("Could not create upload dir:", err.message);
  }
}

if (EPHEMERAL) {
  console.warn("!! No BLOB_READ_WRITE_TOKEN — uploads will be lost when this instance recycles.");
}

let db = {};

function loadLocalDb() {
  try { db = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, "utf8")); } catch { db = {}; }
}

function saveLocalDb() {
  try {
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.warn("Could not persist metadata:", err.message);
  }
}

// Keep the file in memory: on serverless there is no writable scratch dir we can
// rely on, and the buffer goes straight to Blob storage anyway.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});

const serveIndex = (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.send("Dispatch upload service");
};

app.use(express.static(PUBLIC_DIR));
app.get("/", serveIndex);

function safeName(name) {
  return (name || "file").replace(/[\\/]+/g, "_").slice(0, 180);
}

// Blob mode stores everything in the key itself — files/<id>/<original name> —
// so a lookup needs no shared database, which a stateless function cannot keep.
async function findBlob(id) {
  const { blobs } = await blobApi.list({ prefix: `files/${id}/`, limit: 1 });
  return blobs[0] || null;
}

// The store is private: nothing under *.private.blob.vercel-storage.com is
// readable without a signature, so every read goes through a short-lived
// presigned URL. Downloads therefore cannot bypass the log below.
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

async function signedUrlFor(pathname, ttl = SIGNED_URL_TTL_MS) {
  const validUntil = Date.now() + ttl;
  const token = await blobApi.issueSignedToken({ pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await blobApi.presignUrl(token, {
    operation: "get",
    pathname,
    access: "private",
    validUntil
  });
  return presignedUrl;
}

async function getFileMetaById(id) {
  if (USE_BLOB) {
    const blob = await findBlob(id);
    if (!blob) return null;
    return {
      original: decodeURIComponent(path.basename(blob.pathname)),
      size: blob.size,
      url: blob.url,
      fileKey: blob.pathname
    };
  }
  if (!Object.keys(db).length) loadLocalDb();
  return db[id] || null;
}

// ---- download log ----

function describeVisit(req, meta, id) {
  const ua = req.get("user-agent") || "";
  const parsed = device.parse(ua);
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
  return {
    fileId: id,
    fileName: meta ? meta.original : null,
    time: new Date().toISOString(),
    ip,
    country: req.get("x-vercel-ip-country") || null,
    region: req.get("x-vercel-ip-country-region") || null,
    city: decodeURIComponent(req.get("x-vercel-ip-city") || "") || null,
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    // Client hints are more reliable than the UA string when the browser sends them.
    platform: (req.get("sec-ch-ua-platform") || "").replace(/"/g, "") || null,
    model: (req.get("sec-ch-ua-model") || "").replace(/"/g, "") || null,
    referer: req.get("referer") || null,
    userAgent: ua
  };
}

async function recordDownload(entry) {
  try {
    if (USE_BLOB) {
      // One blob per hit: a stateless function cannot append to a shared file
      // without racing itself. The random suffix keeps log URLs unguessable.
      await blobApi.put(`logs/${entry.fileId}/${Date.now()}.json`, JSON.stringify(entry), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: true
      });
      return;
    }
    fs.appendFileSync(LOCAL_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.warn("Could not record download:", err.message);
  }
}

async function readLog(fileId) {
  if (USE_BLOB) {
    const prefix = fileId ? `logs/${fileId}/` : "logs/";
    const { blobs } = await blobApi.list({ prefix, limit: 1000 });
    const recent = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(0, 300);
    const entries = await Promise.all(recent.map(async (b) => {
      try {
        const res = await fetch(await signedUrlFor(b.pathname, 60000));
        return res.ok ? await res.json() : null;
      } catch { return null; }
    }));
    return entries.filter(Boolean);
  }

  let raw = "";
  try { raw = fs.readFileSync(LOCAL_LOG_FILE, "utf8"); } catch { return []; }
  const entries = raw.split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const filtered = fileId ? entries.filter(e => e.fileId === fileId) : entries;
  return filtered.reverse();
}

function authorized(req) {
  if (ADMIN_TOKEN) {
    const given = req.query.token || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    return given === ADMIN_TOKEN;
  }
  // No token configured: fine on a laptop, never on a deployment.
  return !READ_ONLY_ROOT;
}

// ---- upload ----
app.post("/upload", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const id = crypto.randomBytes(6).toString("hex");
    const fileEntry = {
      original: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype || "application/octet-stream",
      created: Date.now()
    };

    try {
      if (USE_BLOB) {
        const blob = await blobApi.put(
          `files/${id}/${safeName(req.file.originalname)}`,
          req.file.buffer,
          {
            access: "private",
            contentType: fileEntry.type,
            addRandomSuffix: false
          }
        );
        fileEntry.url = blob.url;
        fileEntry.fileKey = blob.pathname;
      } else {
        fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, id), req.file.buffer);
        db[id] = fileEntry;
        saveLocalDb();
      }

      const payload = {
        id,
        name: req.file.originalname,
        size: req.file.size,
        link: `${req.protocol}://${req.get("host")}/d/${id}`
      };
      if (EPHEMERAL) payload.warning = "Temporary storage — this link will stop working in a few minutes. Connect a Vercel Blob store.";
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: "Upload failed: " + error.message });
    }
  });
});

// ---- download (this is the shareable link) ----
app.get("/d/:id", async (req, res) => {
  const meta = await getFileMetaById(req.params.id);
  if (!meta) {
    return res.status(404).send(notFoundPage());
  }

  // Awaited, not fire-and-forget: the platform freezes the function once the
  // response is sent, which would drop the write.
  await recordDownload(describeVisit(req, meta, req.params.id));

  if (USE_BLOB && meta.fileKey) {
    return res.redirect(await signedUrlFor(meta.fileKey));
  }

  const filePath = path.join(LOCAL_UPLOAD_DIR, req.params.id);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send(notFoundPage());
  }

  res.download(filePath, meta.original);
});

// ---- who downloaded what ----
app.get("/api/downloads", async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: ADMIN_TOKEN ? "Bad token" : "Set ADMIN_TOKEN to view logs" });
  }
  try {
    res.json({ downloads: await readLog(req.query.id || null) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ storage: USE_BLOB ? "blob" : READ_ONLY_ROOT ? "ephemeral" : "disk", ephemeral: EPHEMERAL });
});

app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

// ---- optional: delete a file ----
app.delete("/d/:id", async (req, res) => {
  const meta = await getFileMetaById(req.params.id);
  if (!meta) return res.status(404).json({ error: "Not found" });

  try {
    if (USE_BLOB) {
      await blobApi.del(meta.fileKey);
    } else {
      const filePath = path.join(LOCAL_UPLOAD_DIR, req.params.id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      delete db[req.params.id];
      saveLocalDb();
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Delete failed: " + error.message });
  }
});

function notFoundPage() {
  return `<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;background:#0F141B;color:#E7ECF2;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
  <div><h1 style="color:#F5A623;letter-spacing:2px">404</h1>
  <p>This file link is invalid or the file was removed.</p>
  <a href="/" style="color:#F5A623">← Send a file</a></div></body>`;
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Dispatch running on http://localhost:${PORT}`));
}

module.exports = app;
