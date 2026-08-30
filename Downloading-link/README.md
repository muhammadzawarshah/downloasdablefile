# Dispatch — apni file-sharing website

Upload koi bhi file → public download link milta hai → dost link pe click karein → file download.
Koi bhi extension chalega: `.zip`, `.exe`, `.bat`, `.iso`, sab.

---

## 1. Pehle local pe test karo (apne laptop pe)

Zaroorat: [Node.js](https://nodejs.org) install hona chahiye (version 18+).

Terminal khol ke is folder ke andar:

```bash
npm install
npm start
```

Ab browser mein kholo: `http://localhost:3000`
File upload karo, link banega jaise `http://localhost:3000/d/abc123`.

> Note: `localhost` waala link sirf tumhare apne computer pe chalega. Dost ke liye public link chahiye → neeche step 2.

---

## 2. Live karo (free hosting — Render.com)

1. Is folder ka code ek **GitHub repo** mein daal do (naya repo bana ke files push kar do).
2. [render.com](https://render.com) pe free account banao.
3. **New → Web Service** → apna GitHub repo select karo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Baaki default rehne do (Render `PORT` khud set kar deta hai).
5. **Create Web Service** dabao. Kuch minute mein site live ho jayegi ek URL pe, jaise:
   `https://dispatch-xxxx.onrender.com`

Ab wo URL kholo, file upload karo, jo `/d/...` link banega **wohi dost ke sath share karo**. Wo click karega, file download ho jayegi. 

(Railway.app par bhi bilkul aise hi deploy ho jata hai — jo aasan lage.)

---

## Zaroori baatein

- **Free hosting ki storage temporary hoti hai.** Render/Railway ke free plan pe jab service restart ya redeploy hoti hai to upload ki hui files delete ho sakti hain. Short-term sharing ke liye theek hai. Permanent chahiye to Render ki **Disk** (paid) laga lo, ya files ko cloud storage (S3 / Cloudflare R2 / Backblaze) pe rakhne waala version bana dunga — bata dena.
- **File size limit** abhi **250 MB** hai. Badalna ho to hosting pe environment variable `MAX_MB` set kar do (jaise `500`).
- **Link public hai** — jise bhi link mile wo download kar sakta hai. Koi password/login is version mein nahi hai (chahiye to add kar deta hoon).
- **Security:** ye tumhari apni site hai, koi bhi file host kar sakta hai. Agar public jagah share kar rahe ho to abuse rokne ke liye login/limit lagana behtar hai — keh dena to add kar dun.

---

## Files

- `server.js` — server (upload + download + delete)
- `public/index.html` — upload page (drag & drop UI)
- `package.json` — dependencies (express, multer)
