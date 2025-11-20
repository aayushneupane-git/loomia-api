import express from "express";
import multer from "multer";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import axios from "axios";

const app = express();
app.use(express.json());
const upload = multer({ dest: "uploads/" });

// Upload Route
app.post("/upload", upload.single("video"), async (req, res) => {
  const videoFile = req.file.path;
  // Split using FFmpeg
  const splitOutputDir = path.join("chunks", Date.now().toString());
  fs.mkdirSync(splitOutputDir);

  await splitVideo(videoFile, splitOutputDir);

  // Dispatch chunks to workers
  const chunkFiles = fs.readdirSync(splitOutputDir);
  const transcriptionPromises = chunkFiles.map(async chunk => {
    const response = await axios.post("http://worker:5001/process", {
      filePath: `${splitOutputDir}/${chunk}`
    });
    return response.data.text;
  });

  const transcriptions = await Promise.all(transcriptionPromises);
  const finalText = transcriptions.join(" ");

  // Summarization using OpenAI
  const summary = await summarizeText(finalText);

  res.json({ summary, fullText: finalText });
});

// FFmpeg Split Function
function splitVideo(input, outputDir) {
  return new Promise(resolve => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", input,
      "-f", "segment", "-segment_time", "300",
      "-reset_timestamps", "1",
      `${outputDir}/chunk_%03d.mp4`
    ]);

    ffmpeg.on("exit", resolve);
  });
}

// OpenAI Summarization
async function summarizeText(text) {
  const fetch = (await import("node-fetch")).default;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Summarize clearly." },
        { role: "user", content: text }
      ]
    })
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

app.listen(5000, () => console.log("API running on port 5000"));
