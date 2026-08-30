// Dispatch — tiny file-sharing server
// Upload any file  ->  get a public download link  ->  friend clicks  ->  file downloads.

const express = require("express");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");

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
const LOCAL_UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const LOCAL_DATA_FILE = path.join(ROOT_DIR, "files.json");
const BLOB_METADATA_KEY = "dispatch-metadata.json";

if (!fs.existsSync(LOCAL_UPLOAD_DIR)) fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });

let db = {};

function loadLocalDb() {
  try { db = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, "utf8")); } catch { db = {}; }
}

async function loadBlobDb() {
  try {
    const existingMeta = await blobApi.head(BLOB_METADATA_KEY);
  } catch {
    db = {};
  }
}

async function loadDb() {
  if (USE_BLOB) {
    await loadBlobDb();
    return;
  }
  loadLocalDb();
}

function saveLocalDb() {
  fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(db, null, 2));
}

async function saveDb() {
  if (USE_BLOB) {
    await blobApi.put(BLOB_METADATA_KEY, JSON.stringify(db, null, 2), {
    });
    return;
  }
  saveLocalDb();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOCAL_UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(6).toString("hex"))
});
const upload = multer({ storage, limits: { fileSize: MAX_MB * 1024 * 1024 } });

const serveIndex = (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.send("Dispatch upload service");
};

app.use(express.static(PUBLIC_DIR));
app.get("/", serveIndex);

async function getFileMetaById(id) {
  if (!db || Object.keys(db).length === 0) {
    await loadDb();
  }
  return db[id] || null;
}

// ---- upload ----
app.post("/upload", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const id = req.file.filename;
    const fileEntry = {
      original: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype || "application/octet-stream",
      created: Date.now()
    };

    try {
      if (USE_BLOB) {
        const blob = await blobApi.put(`files/${id}`, fs.readFileSync(req.file.path), {
          access: "public",
          contentType: fileEntry.type
        });
        fileEntry.url = blob.url;
        fileEntry.fileKey = `files/${id}`;
        fs.unlinkSync(req.file.path);
      }

      db[id] = fileEntry;
      await saveDb();

      res.json({
        id,
        name: req.file.originalname,
        size: req.file.size,
        link: `${req.protocol}://${req.get("host")}/d/${id}`
      });
    } catch (error) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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

  if (USE_BLOB && meta.url) {
    return res.redirect(meta.url);
  }

  const filePath = path.join(LOCAL_UPLOAD_DIR, req.params.id);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send(notFoundPage());
  }

  res.download(filePath, meta.original);
});

// ---- optional: delete a file ----
app.delete("/d/:id", async (req, res) => {
  const meta = await getFileMetaById(req.params.id);
  if (!meta) return res.status(404).json({ error: "Not found" });

  try {
    if (USE_BLOB && meta.fileKey) {
      await blobApi.del(meta.fileKey);
    } else {
      const filePath = path.join(LOCAL_UPLOAD_DIR, req.params.id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    delete db[req.params.id];
    await saveDb();
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
