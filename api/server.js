import express from "express";
import multer from "multer";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
import FormData from "form-data";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.js";
import saveRoutes from "./routes/save.js";

dotenv.config();
const app = express();

// ====== CORS CONFIG ======
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"],
  credentials: true
}));

// Handle preflight OPTIONS globally
app.options("*", cors({
  origin: "https://www.loomia.fun",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"],
  credentials: true
}));

app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "https://www.loomia.fun", credentials: true },
});

io.on("connection", (socket) => console.log("Client connected:", socket.id));

function sendProgress(socketId, progress, message) {
  io.to(socketId).emit("uploadProgress", { progress, message });
}

// ====== ROUTES ======
app.use("/auth", authRoutes);
app.use("/data", saveRoutes);

// ====== MULTER STORAGE ======
const uploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = "/tmp/uploads";
    await fsPromises.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage: uploadStorage });

// ====== WORKERS ======
const WORKERS = [
  "http://worker1:5001/process",
  "http://worker2:5001/process",
  "http://worker3:5001/process",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== ASYNC CLEANUP ======
export const clearFolder = async (folderPath) => {
  if (fs.existsSync(folderPath)) {
    const files = await fsPromises.readdir(folderPath);
    await Promise.all(files.map(async (file) => {
      const curPath = path.join(folderPath, file);
      const stats = await fsPromises.lstat(curPath);
      if (stats.isDirectory()) await clearFolder(curPath);
      else await fsPromises.unlink(curPath);
    }));
    await fsPromises.rmdir(folderPath);
  }
};

// ====== VIDEO UPLOAD ======
app.post("/upload", upload.single("video"), async (req, res) => {
  const socketId = req.body.socketId;
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded" });

    const timestamp = Date.now().toString();
    const chunkDir = path.join("/tmp/chunks", timestamp);
    await fsPromises.mkdir(chunkDir, { recursive: true });

    const videoPath = req.file.path;
    sendProgress(socketId, 5, "Video saved, starting split...");

    const chunkFiles = await splitVideo(videoPath, chunkDir);
    sendProgress(socketId, 30, "Video split into chunks");

    // Assign chunks to workers evenly
    const totalChunks = chunkFiles.length;
    const chunksPerWorker = Math.ceil(totalChunks / WORKERS.length);
    const workerAssignments = [];

    for (let i = 0; i < WORKERS.length; i++) {
      const start = i * chunksPerWorker;
      const end = start + chunksPerWorker;
      const series = chunkFiles.slice(start, end);
      if (series.length > 0)
        workerAssignments.push({ worker: WORKERS[i], series });
    }

    // Process chunks on workers
    const workerResults = await Promise.all(
      workerAssignments.map(async ({ worker, series }) => {
        const texts = await Promise.all(
          series.map(async (filePath) => {
            const form = new FormData();
            form.append("file", fs.createReadStream(filePath));
            try {
              const resp = await axios.post(worker, form, {
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
              });
              io.to(socketId).emit("workerChunkProgress", {
                worker,
                chunk: path.basename(filePath),
                status: "done",
              });
              return resp.data.text || "";
            } catch (err) {
              console.error(`Worker error on ${filePath}:`, err.message);
              io.to(socketId).emit("workerChunkProgress", {
                worker,
                chunk: path.basename(filePath),
                status: "failed",
              });
              return "";
            }
          })
        );
        return texts.join(" ");
      })
    );

    const fullText = workerResults.join(" ").trim();
    sendProgress(socketId, 85, "All chunks processed, generating summary and quiz...");

    const [summary, quiz] = await Promise.all([
      summarizeText(fullText),
      generateQuiz(fullText),
    ]);

    sendProgress(socketId, 100, "Processing complete!");
    res.json({ summary, fullText, quiz });

    setTimeout(async () => {
      await clearFolder("/tmp/uploads");
      await clearFolder("/tmp/chunks");
    }, 2000);
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload processing failed" });
  }
});

// ====== VIDEO SPLIT ======
function splitVideo(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", videoPath,
      "-c", "copy",
      "-f", "segment",
      "-segment_time", "60",
      "-reset_timestamps", "1",
      "-threads", "0",
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

// ====== SUMMARIZATION ======
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

// ====== QUIZ GENERATION ======
function fixQuizAnswers(quiz) {
  if (!Array.isArray(quiz) || quiz.length === 0) return [];
  const indices = quiz.map(q => q.correct);
  const sameIndex = indices.every(i => i === indices[0]);
  if (sameIndex) {
    quiz.forEach(q => {
      let newIndex = Math.floor(Math.random() * 4);
      if (newIndex === q.correct) newIndex = (newIndex + 1) % 4;
      [q.options[q.correct], q.options[newIndex]] = [q.options[newIndex], q.options[q.correct]];
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
            content: `Generate exactly 8 MCQ questions. Return ONLY a valid JSON array: [{"question": "...", "options": ["...","...","...","..."], "correct": number}]. Rules: correct index must be different for each question, no explanations or markdown. Options answers must be 0-3`
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

// ====== MONGO DB ======
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("📌 MongoDB Connected"))
  .catch(err => console.error("Mongo Error:", err));

app.get("/", (req, res) => res.send("LOOMIA API running"));

const PORT = 5000;
httpServer.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
