import express from "express";
import multer from "multer";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
import FormData from "form-data";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

import authRoutes from "./routes/auth.js";
import saveRoutes from "./routes/save.js";

dotenv.config();
const app = express();
app.use(express.json());

app.use(cors({ origin: "http://localhost:3000", credentials: true }));

/* ================================ SOCKET.IO ================================ */
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "http://localhost:3000", credentials: true } });

function sendProgress(socketId, progress, message) {
  io.to(socketId).emit("uploadProgress", { progress, message });
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
});

/* ================================ ROUTES ================================ */
app.use("/auth", authRoutes);
app.use("/data", saveRoutes);

/* ================================ MULTER (DISK STORAGE) ================================ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join("uploads", Date.now().toString());
    fs.mkdirSync(uploadDir, { recursive: true });
    req.uploadDir = uploadDir; // store path in request for later use
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

/* ================================ VIDEO UPLOAD ================================ */
app.post("/upload", upload.single("video"), async (req, res) => {
  const socketId = req.body.socketId;
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded" });

    const videoPath = req.file.path;
    const chunkDir = path.join("chunks", Date.now().toString());
    fs.mkdirSync(chunkDir, { recursive: true });

    sendProgress(socketId, 5, "Video saved, starting split...");

    const chunkFiles = await splitVideo(videoPath, chunkDir);

    sendProgress(socketId, 30, "Video split into chunks");

    const transcriptionPromises = chunkFiles.map(async (filePath, idx) => {
      const chunkProgress = 30 + ((idx + 1) / chunkFiles.length) * 50;
      sendProgress(socketId, chunkProgress, `Processing chunk ${idx + 1}`);
      try {
        const form = new FormData();
        form.append("file", fs.createReadStream(filePath));

        const resp = await axios.post("http://worker:5001/process", form, {
          headers: form.getHeaders(),
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

        return resp.data.text || "";
      } catch (err) {
        console.error(`Worker error on chunk ${idx}:`, err.response?.data || err.message);
        return "";
      }
    });

    const transcriptions = await Promise.all(transcriptionPromises);

    sendProgress(socketId, 85, "Chunks processed, generating summary...");

    const fullText = transcriptions.join(" ").trim();
    const summary = await summarizeText(fullText);
    const quiz = await generateQuiz(fullText);

    sendProgress(socketId, 100, "Processing complete!");

    res.json({ summary, fullText, quiz });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload processing failed" });
  }
});

/* ================================ VIDEO SPLIT ================================ */
function splitVideo(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", videoPath,
      "-c", "copy",
      "-f", "segment",
      "-segment_time", "60",
      "-reset_timestamps", "1",
      path.join(outputDir, "chunk_%03d.mp4"),
    ]);

    ffmpeg.stderr.on("data", (data) => console.log(`FFmpeg: ${data}`));
    ffmpeg.on("exit", (code) => {
      if (code !== 0) return reject(new Error("FFmpeg split failed"));
      const chunks = fs.readdirSync(outputDir).map(f => path.join(outputDir, f));
      resolve(chunks);
    });
  });
}

/* ================================ SUMMARIZATION ================================ */
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
  return data.choices?.[0]?.message?.content || "";
}

/* ================================ QUIZ GENERATION ================================ */
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

async function generateQuiz(text) {
  try {
    const fetch = (await import("node-fetch")).default;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
- Correct index must be correct and different for each question.
- No explanations, no markdown.`,
          },
          { role: "user", content: text },
        ],
      }),
    });

    const data = await response.json();
    let quizText = data.choices?.[0]?.message?.content || "";
    quizText = quizText.replace(/json|`/gi, "").trim();
    const parsedQuiz = JSON.parse(quizText);
    return fixQuizAnswers(parsedQuiz);
  } catch (error) {
    console.error("❌ Quiz parse error or fetch failed:", error);
    return [];
  }
}

/* ================================ MONGO DB ================================ */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("📌 MongoDB Connected"))
  .catch((err) => console.error("Mongo Error:", err));

/* ================================ ROOT ================================ */
app.get("/", (req, res) => res.send("LOOMIA API running"));

/* ================================ SERVER ================================ */
const PORT = 5000;
httpServer.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
