import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import dotenv from "dotenv";
import path from "path";

dotenv.config();
const app = express();

/* ================================ MULTER (DISK STORAGE) ================================ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join("tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});
const upload = multer({ storage });

/* ================================ PROCESS VIDEO CHUNK ================================ */
app.post("/process", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: true, message: "No file uploaded" });

    const videoPath = req.file.path;
    const audioPath = videoPath.replace(/\.(mp4|mkv|mov)$/, ".mp3");

    await extractAudio(videoPath, audioPath);

    const transcript = await transcribeAudio(audioPath);

    // Cleanup
    [videoPath, audioPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

    res.json({ text: transcript });
  } catch (err) {
    console.error("WORKER ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: true, message: "Worker failed" });
  }
});

/* ================================ EXTRACT AUDIO ================================ */
function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-i", videoPath, "-vn", "-acodec", "mp3", outputPath]);
    ffmpeg.stderr.on("data", (data) => console.log(`FFmpeg: ${data}`));
    ffmpeg.on("exit", (code) => code === 0 ? resolve() : reject(new Error("FFmpeg audio extraction failed")));
  });
}

/* ================================ TRANSCRIBE AUDIO ================================ */
async function transcribeAudio(audioFile) {
  const form = new FormData();
  form.append("file", fs.createReadStream(audioFile));
  form.append("model", "gpt-4o-transcribe");

  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );

  return response.data.text;
}

app.listen(5001, () => console.log("🔥 Worker running on port 5001"));
