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
const upload = multer({ storage: multer.memoryStorage() }); // keep chunks in memory

/* ================================ PROCESS VIDEO CHUNK ================================ */
app.post("/process", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: true, message: "No file uploaded" });

    const tmpFile = path.join("/tmp", `${Date.now()}.mp4`);
    const audioPath = path.join("/tmp", `${Date.now()}.mp3`);

    // Save uploaded buffer to temporary file
    fs.writeFileSync(tmpFile, req.file.buffer);

    // Extract audio
    await extractAudio(tmpFile, audioPath);

    // Transcribe audio using OpenAI Whisper
    const transcript = await transcribeAudio(audioPath);

    // Cleanup
    [tmpFile, audioPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

    res.json({ text: transcript });
  } catch (err) {
    console.error("WORKER ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: true, message: "Worker failed" });
  }
});

/* ================================ EXTRACT AUDIO ================================ */
function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", videoPath,
      "-vn",           // remove video
      "-acodec", "mp3",
      outputPath
    ]);

    ffmpeg.stderr.on("data", data => console.log(`FFmpeg: ${data}`));
    ffmpeg.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg audio extraction failed"));
    });
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
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  return response.data.text;
}

/* ================================ START WORKER ================================ */
app.listen(5001, () => console.log("🔥 Worker running on port 5001"));
