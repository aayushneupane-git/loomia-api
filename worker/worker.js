import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import fs from "fs";
import FormData from "form-data";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const upload = multer({ dest: "worker_uploads/" });

/* ============================================================
   🎧 Extract + Transcribe Chunk
   ============================================================ */
app.post("/process", upload.single("file"), async (req, res) => {
  try {
    const videoPath = req.file.path;
    const audioPath = videoPath + ".mp3";

    await extractAudio(videoPath, audioPath);

    const transcript = await transcribeAudio(audioPath);

    fs.unlinkSync(videoPath); // cleanup
    fs.unlinkSync(audioPath);

    res.json({ text: transcript });
  } catch (err) {
    console.error("WORKER ERROR:", err);
    res.status(500).json({ error: true, message: "Worker failed" });
  }
});

/* ============================================================
   🎬 Convert Video → MP3
   ============================================================ */
function extractAudio(input, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", input,
      "-vn",
      "-acodec", "mp3",
      output
    ]);

    ffmpeg.on("exit", (code) => {
      if (code === 0) resolve();
      else reject("FFmpeg audio error");
    });
  });
}

/* ============================================================
   🗣 Send Audio to OpenAI Whisper
   ============================================================ */
async function transcribeAudio(audioFile) {
  const form = new FormData();
  form.append("file", fs.createReadStream(audioFile));
  form.append("model", "gpt-4o-transcribe");

  const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return response.data.text;
}

/* ============================================================
   🚀 Worker Start
   ============================================================ */
app.listen(5001, () => console.log("Worker running on port 5001"));
