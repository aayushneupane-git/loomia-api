import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * ========= UTIL: Extract audio from video =============
 */
function extractAudio(videoPath) {
  return new Promise((resolve, reject) => {
    const output = videoPath.replace(/\.\w+$/, ".mp3");

    const ffmpeg = spawn("ffmpeg", [
      "-y", // overwrite if exists
      "-i", videoPath,
      "-vn",
      "-acodec", "libmp3lame",
      output
    ]);

    ffmpeg.on("error", (err) => reject(err));
    ffmpeg.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

/**
 * ========= UTIL: Transcribe audio via OpenAI ==========
 */
async function transcribeAudio(audioPath) {
  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "gpt-4o-mini-transcribe", // or "whisper-1"
      response_format: "text"
    });
    return result;
  } catch (err) {
    console.error("Transcription Error:", err.response?.data || err);
    throw new Error("Transcription failed");
  }
}

/**
 * =============== MAIN WORKER ENDPOINT ===================
 */
app.post("/process", async (req, res) => {
  const { filePath } = req.body;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: "Invalid file path" });
  }

  try {
    console.log(`🎬 Worker received: ${filePath}`);

    // Convert video -> mp3
    const audioPath = await extractAudio(filePath);
    console.log(`🎧 Audio extracted: ${audioPath}`);

    // Transcribe
    const text = await transcribeAudio(audioPath);
    console.log("📝 Transcription completed!");

    // Cleanup
    try { fs.unlinkSync(audioPath); console.log("🧹 Temp audio cleaned"); } catch {}

    return res.json({ text });

  } catch (error) {
    console.error("❌ Worker failed:", error.message);
    return res.status(500).json({ error: "Worker processing failed" });
  }
});

/**
 * ==================== SERVER START =======================
 */
app.listen(5001, "0.0.0.0", () =>
  console.log("⚙️ Worker running on port 5001")
);
