import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// Store uploaded chunk files on disk
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join("worker_uploads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

    [videoPath, audioPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

    res.json({ text: transcript });
  } catch (err) {
    console.error("WORKER ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Worker failed" });
  }
});

function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-i", videoPath, "-vn", "-acodec", "mp3", outputPath]);
    ffmpeg.stderr.on("data", data => console.log(`FFmpeg: ${data}`));
    ffmpeg.on("exit", code => (code === 0 ? resolve() : reject(new Error("FFmpeg failed"))));
  });
}

async function transcribeAudio(audioFile) {
  const form = new FormData();
  form.append("file", fs.createReadStream(audioFile));
  form.append("model", "gpt-4o-transcribe");

  const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  return response.data.text;
}

app.listen(5001, () => console.log("🔥 Worker running on port 5001"));
