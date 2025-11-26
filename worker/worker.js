import express from "express";
import multer from "multer";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// Store uploaded chunk files on ephemeral storage
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const dir = "/tmp/worker_uploads";
      await fsPromises.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});

app.post("/process", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const videoPath = req.file.path;
    const audioPath = videoPath.replace(".mp4", ".mp3");

    await extractAudio(videoPath, audioPath);
    const transcript = await transcribeAudio(audioPath);

    // Async cleanup
    Promise.all([videoPath, audioPath].map(async (f) => fs.existsSync(f) && fsPromises.unlink(f)));

    res.json({ text: transcript });
  } catch (err) {
    console.error("WORKER ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Worker failed" });
  }
});

function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      videoPath,
      "-vn",
      "-acodec",
      "mp3",
      "-threads",
      "0",
      outputPath,
    ]);
    ffmpeg.stderr.on("data", (data) => console.log(`FFmpeg: ${data}`));
    ffmpeg.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("FFmpeg failed"))));
  });
}

async function transcribeAudio(audioFile) {
  const form = new FormData();
  form.append("file", fs.createReadStream(audioFile));
  form.append("model", "gpt-4o-transcribe");

  const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    timeout: 60000, // 60s timeout to avoid blocking
  });

  return response.data.text;
}

const PORT = 5001;
app.listen(PORT, () => console.log(`🔥 Worker running on port ${PORT}`));
