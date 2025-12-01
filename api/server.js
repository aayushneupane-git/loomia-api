import express from "express";
import multer from "multer";
import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";
import { createReadStream } from "fs";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
import FormData from "form-data";
import { createServer } from "http";
import { Server } from "socket.io";
import authRoutes from "./routes/auth.js";
import saveRoutes from "./routes/save.js";
import { rimraf } from "rimraf";

dotenv.config();

const app = express();

// ====== BODY PARSERS ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== ROUTES ======
app.use("/auth", authRoutes);
app.use("/data", saveRoutes);

// ====== HTTP + SOCKET.IO ======
const httpServer = createServer(app);
const io = new Server(httpServer);

io.on("connection", (socket) => console.log("Socket connected:", socket.id));

// ====== WORKERS ======
const WORKERS = [
  "http://worker1:5001/process",
  "http://worker2:5001/process",
  "http://worker3:5001/process",
];

// ====== UTILITIES ======
function sendProgress(socketId, progress, message) {
  io.to(socketId).emit("uploadProgress", { progress, message });
}

// Multer for uploads (per-job folder)
const uploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const jobId = Date.now().toString();
    const dir = `/tmp/uploads/${jobId}`;
    await fs.mkdir(dir, { recursive: true });
    req.uploadDir = dir; // save for cleanup
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage: uploadStorage });

// Clear folder safely
async function clearFolder(folderPath) {
  try {
    await rimraf(folderPath);
  } catch (err) {
    console.error("Failed to clear folder:", err);
  }
}

// Split video into chunks
function splitVideo(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i",
      videoPath,
      "-c",
      "copy",
      "-f",
      "segment",
      "-segment_time",
      "60",
      "-reset_timestamps",
      "1",
      "-threads",
      "0",
      path.join(outputDir, "chunk_%03d.mp4"),
    ]);

    ff.stderr.on("data", (d) => console.log("FFmpeg:", d.toString()));

    ff.on("exit", async (code) => {
      if (code !== 0) return reject(new Error("FFmpeg failed"));
      const files = await fs.readdir(outputDir);
      resolve(files.map((f) => path.join(outputDir, f)));
    });
  });
}

// OpenAI summarization
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
        { role: "system", content: "Summarize clearly in 4–6 sentences." },
        { role: "user", content: text },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// Quiz generation
async function generateQuiz(text) {
  try {
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
          { role: "system", content: "Generate 8 MCQs as JSON [{question, options:[4], correct:index}]" },
          { role: "user", content: text },
        ],
      }),
    });

    let raw = (await res.json()).choices?.[0]?.message?.content || "";
    raw = raw.replace(/`|json/gi, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("Quiz generation failed:", err);
    return [];
  }
}

// ====================
// QUEUE SYSTEM
// ====================
const jobResults = new Map();
let isBusy = false;
const jobQueue = [];

async function processJob(job) {
  const { req, jobId } = job;
  const socketId = req.body.socketId;

  const uploadDir = req.uploadDir;
  const chunkDir = `/tmp/chunks/${jobId}`;
  await fs.mkdir(chunkDir, { recursive: true });

  try {
    const videoPath = req.file.path;
    sendProgress(socketId, 10, "Splitting video...");
    const chunkFiles = await splitVideo(videoPath, chunkDir);

    sendProgress(socketId, 40, "Sending chunks to workers...");
    const perWorker = Math.ceil(chunkFiles.length / WORKERS.length);

    const workerResults = await Promise.all(
      WORKERS.map(async (workerUrl, i) => {
        const group = chunkFiles.slice(i * perWorker, (i + 1) * perWorker);
        if (group.length === 0) return "";

        const texts = await Promise.all(
          group.map(async (filePath) => {
            const form = new FormData();
            form.append("file", createReadStream(filePath));
            try {
              const res = await axios.post(workerUrl, form, { headers: form.getHeaders() });
              io.to(socketId).emit("uploadProgress", { progress: 50, message: `Worker done: ${path.basename(filePath)}` });
              return res.data?.text || "";
            } catch {
              return "";
            }
          })
        );
        return texts.join(" ");
      })
    );

    const fullText = workerResults.join(" ").trim();
    sendProgress(socketId, 80, "Generating summary & quiz...");

    const [summary, quiz] = await Promise.all([summarizeText(fullText), generateQuiz(fullText)]);

    jobResults.set(jobId, { status: "done", summary, quiz, fullText });
    sendProgress(socketId, 100, "Processing completed ✅");
  } catch (err) {
    console.error(err);
    jobResults.set(jobId, { status: "error", error: err.message });
  } finally {
    // Cleanup per-job folders only
    await clearFolder(uploadDir);
    await clearFolder(chunkDir);
  }
}

function runQueue() {
  if (isBusy || jobQueue.length === 0) return;
  isBusy = true;

  const job = jobQueue.shift();
  processJob(job).finally(() => {
    isBusy = false;
    runQueue();
  });
}

// ====================
// ENDPOINTS
// ====================

// Upload (returns jobId)
app.post("/upload", upload.single("video"), (req, res) => {
  const jobId = Date.now().toString();
  jobResults.set(jobId, { status: "queued" });

  jobQueue.push({ req, jobId });
  runQueue();

  return res.json({
    status: "queued",
    jobId,
    message: "Your video has been queued for processing.",
  });
});

// Get result by jobId
app.get("/result/:jobId", (req, res) => {
  const job = jobResults.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json(job);
});

// ====================
// MONGO + SERVER START
// ====================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Mongo connected"))
  .catch((err) => console.error("Mongo error:", err));

httpServer.listen(5000, () => console.log("🔥 API running on port 5000"));
