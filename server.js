// server.js — mySMM video render service (deploy this on Render as a Docker web service)
//
// POST /make-video
// Headers: x-api-key: <shared secret, must match API_KEY env var>
// Body: { "imageUrl": "https://...", "durationSeconds": 3 }
// Response: raw video/mp4 bytes

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // set this in Render's environment variables

// Serial queue: this free-tier instance has very limited memory, and running
// two FFmpeg renders at once can exhaust it and crash the whole service.
// Every /make-video request goes through this queue so only one render ever
// runs at a time — extra requests simply wait their turn instead of racing.
let queue = Promise.resolve();
function enqueue(taskFn) {
  const result = queue.then(taskFn, taskFn);
  queue = result.catch(() => {});
  return result;
}

app.post("/make-video", async (req, res) => {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const { imageUrl, durationSeconds } = req.body || {};
  if (!imageUrl) {
    return res.status(400).json({ error: "Missing imageUrl." });
  }

  try {
    const videoBuffer = await enqueue(() => renderVideo(imageUrl, durationSeconds));
    res.setHeader("Content-Type", "video/mp4");
    res.send(videoBuffer);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Video render failed: ${err.message}` });
  }
});

// POST /compose-image
// Body: { photoUrl, textCardBase64 (a PNG, base64-encoded, sized width x (height-imageHeight)),
//         width, height, imageHeight }
// Crops/scales the photo to fill the top `imageHeight` px, stamps the text
// card onto the remaining bottom portion, and returns one flattened JPEG.
// This is a single-frame operation — much lighter than the video render.
app.post("/compose-image", async (req, res) => {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const { photoUrl, textCardBase64, width, height, imageHeight } = req.body || {};
  if (!photoUrl || !textCardBase64 || !width || !height || !imageHeight) {
    return res.status(400).json({ error: "Missing photoUrl, textCardBase64, width, height, or imageHeight." });
  }

  try {
    const imageBuffer = await enqueue(() =>
      composeImage({ photoUrl, textCardBase64, width, height, imageHeight })
    );
    res.setHeader("Content-Type", "image/jpeg");
    res.send(imageBuffer);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Compose failed: ${err.message}` });
  }
});

async function renderVideo(imageUrl, durationSeconds) {
  const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : 3;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mysmm-"));
  const inputPath = path.join(workDir, "input.png");
  const outputPath = path.join(workDir, "output.mp4");

  try {
    await downloadFile(imageUrl, inputPath);
    await runFfmpeg(inputPath, outputPath, duration);
    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function composeImage({ photoUrl, textCardBase64, width, height, imageHeight }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mysmm-compose-"));
  const photoPath = path.join(workDir, "photo.jpg");
  const cardPath = path.join(workDir, "card.png");
  const outputPath = path.join(workDir, "output.jpg");

  try {
    await downloadFile(photoUrl, photoPath);
    fs.writeFileSync(cardPath, Buffer.from(textCardBase64, "base64"));
    await runFfmpegCompose(photoPath, cardPath, outputPath, width, height, imageHeight);
    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`mySMM video service listening on ${PORT}`));

// ---------- helpers ----------

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    client
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download image: status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

function runFfmpeg(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    const fps = 25;
    const frames = Math.round(duration * fps);

    // Ken Burns: slow zoom in from 1.0x to ~1.15x over the clip, output vertical
    // 1080x1920 (Reels aspect), with a silent audio track (some validators
    // reject video-only files), H.264 + yuv420p as required by Instagram.
    // zoompan at full 1080x1920 for every frame is memory-heavy on Render's
    // free tier (512MB) — work at half resolution during the zoom, then
    // scale up once at the end, which uses much less memory per frame.
    const args = [
      "-y",
      "-loop", "1",
      "-i", inputPath,
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", `scale=540:960,zoompan=z='min(zoom+0.0012,1.15)':d=${frames}:s=540:960:fps=${fps},scale=1080:1920,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-t", String(duration),
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ];

    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}

// Scales/crops the photo to fill the top `imageHeight` px (object-fit:cover
// equivalent), then overlays the pre-rendered text card at the bottom.
// Single frame — no video encoding, so this is fast and light on memory.
function runFfmpegCompose(photoPath, cardPath, outputPath, width, height, imageHeight) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", photoPath,
      "-i", cardPath,
      "-filter_complex",
      `[0:v]scale=w=${width}:h=${imageHeight}:force_original_aspect_ratio=increase,crop=${width}:${imageHeight}[bg];[bg][1:v]overlay=0:${imageHeight}[out]`,
      "-map", "[out]",
      "-frames:v", "1",
      "-q:v", "3",
      outputPath,
    ];

    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}
