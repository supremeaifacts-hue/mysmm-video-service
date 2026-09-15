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

app.post("/make-video", async (req, res) => {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const { imageUrl, durationSeconds } = req.body || {};
  if (!imageUrl) {
    return res.status(400).json({ error: "Missing imageUrl." });
  }
  const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : 3;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mysmm-"));
  const inputPath = path.join(workDir, "input.png");
  const outputPath = path.join(workDir, "output.mp4");

  try {
    await downloadFile(imageUrl, inputPath);
    await runFfmpeg(inputPath, outputPath, duration);

    const videoBuffer = fs.readFileSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.send(videoBuffer);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Video render failed: ${err.message}` });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
});

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
    const args = [
      "-y",
      "-loop", "1",
      "-i", inputPath,
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", `zoompan=z='min(zoom+0.0012,1.15)':d=${frames}:s=1080x1920:fps=${fps},format=yuv420p`,
      "-c:v", "libx264",
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
