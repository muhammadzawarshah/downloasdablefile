// Dispatch — tiny file-sharing server
// Upload any file  ->  get a public download link  ->  friend clicks  ->  file downloads.

const express = require("express");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
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

// On Vercel the deployment root is a read-only filesystem (EROFS); only /tmp is
// writable, and it is wiped between invocations. So never write inside ROOT_DIR
// there — Blob storage is the real backend in that case.
const READ_ONLY_ROOT = Boolean(
  process.env.VERCEL ||
  process.env.VERCEL_ENV ||
  process.env.NOW_REGION ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  ROOT_DIR.startsWith("/var/task")
);
const WRITABLE_DIR = READ_ONLY_ROOT ? path.join(os.tmpdir(), "dispatch") : ROOT_DIR;
const LOCAL_UPLOAD_DIR = path.join(WRITABLE_DIR, "uploads");
const LOCAL_DATA_FILE = path.join(WRITABLE_DIR, "files.json");

if (!USE_BLOB) {
  if (READ_ONLY_ROOT) {
    console.warn("WARNING: BLOB_READ_WRITE_TOKEN is missing on Vercel! Uploads using /tmp will not persist across function invocations. Please connect a Vercel Blob store.");
  }
  try {
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.warn("Could not create upload dir:", err.message);
  }
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
            access: "public",
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

      res.json({
        id,
        name: req.file.originalname,
        size: req.file.size,
        link: `${req.protocol}://${req.get("host")}/d/${id}`
      });
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

  if (USE_BLOB && meta.url) {
    return res.redirect(`${meta.url}?download=1`);
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
