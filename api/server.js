import express from "express";
import multer from "multer";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import axios from "axios";
import mongoose from "mongoose";
import authRoutes from "./routes/auth.js";
import saveRoutes from "./routes/save.js";
import dotenv from "dotenv";
import FormData from "form-data";
dotenv.config();

const app = express();
app.use(express.json());

/* ================================ 📌 ROUTES ================================ */
app.use("/auth", authRoutes);
app.use("/data", saveRoutes);

/* ================================ 📌 MULTER ================================ */
const upload = multer({ dest: "uploads/" });

/* ================================ 📌 UPLOAD FLOW ================================ */
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded" });

    const videoFile = req.file.path;
    const splitOutputDir = path.join("chunks", Date.now().toString());
    fs.mkdirSync(splitOutputDir, { recursive: true });

    // ➤ Split into chunks
    await splitVideo(videoFile, splitOutputDir);

    // ➤ Process chunks in worker
    const chunkFiles = fs.readdirSync(splitOutputDir);

    const transcriptionPromises = chunkFiles.map(async (chunk) => {
      const filePath = path.join(splitOutputDir, chunk);
      const form = new FormData();
      form.append("file", fs.createReadStream(filePath));

      const resp = await axios.post("http://worker:5001/process", form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      return resp.data.text;
    });

    const transcriptions = await Promise.all(transcriptionPromises);
    const fullText = transcriptions.join(" ");

    const summary = await summarizeText(fullText);
    const quiz = await generateQuiz(fullText);

    res.json({ summary, fullText, quiz });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload processing failed" });
  }
});

/* ================================ 🎬 FFmpeg Split ================================ */
function splitVideo(input, outputDir) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", input,
      "-f", "segment",
      "-segment_time", "300",
      "-reset_timestamps", "1",
      path.join(outputDir, "chunk_%03d.mp4"),
    ]);

    ffmpeg.stderr.on("data", (data) => console.log(`FFmpeg: ${data}`));

    ffmpeg.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg split failed"));
    });
  });
}

/* ================================ 🤖 Summarization ================================ */
async function summarizeText(text) {
  const fetch = (await import("node-fetch")).default;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Summarize clearly in 4-6 sentences." },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0]?.message?.content || "";
}

/* ================================ 🧠 Quiz Fix Helper ================================ */
function fixQuizAnswers(quiz) {
  if (!Array.isArray(quiz) || quiz.length === 0) return [];

  const indices = quiz.map((q) => q.correct);
  const sameIndex = indices.every((i) => i === indices[0]);

  if (sameIndex) {
    quiz.forEach((q) => {
      const correctText = q.options[q.correct];
      let newIndex = Math.floor(Math.random() * 4);
      if (newIndex === q.correct) newIndex = (newIndex + 1) % 4;

      [q.options[q.correct], q.options[newIndex]] = [
        q.options[newIndex],
        q.options[q.correct],
      ];

      q.correct = newIndex;
    });
  }
  return quiz;
}

/* ================================ 🧠 Quiz Generation ================================ */
async function generateQuiz(text) {
  const fetch = (await import("node-fetch")).default;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `Generate exactly 8 MCQ questions.
Return ONLY a valid JSON array:
[{"question": "...", "options": ["...","...","...","..."], "correct": number}]
Rules:
- correct index must be true and NOT the same for all.
- No explanation, no markdown.`,
        },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await res.json();
  let quizText = data.choices[0]?.message?.content || "";

  quizText = quizText.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(quizText);
    return fixQuizAnswers(parsed);
  } catch (e) {
    console.error("❌ Quiz parse error:", quizText);
    return [];
  }
}

/* ================================ 🗄️ MongoDB ================================ */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("📌 MongoDB Connected"))
  .catch((err) => console.error("Mongo Error:", err));

/* ================================ 🌐 Root ================================ */
app.get("/", (req, res) => res.send("LOOMIA API running"));

/* ================================ 🚀 Server ================================ */
app.listen(5000, () => console.log("🔥 API running on port 5000"));
