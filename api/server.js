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
dotenv.config();

const app = express();
app.use(express.json());

/* ============================================================
   📌 ROUTES REGISTRATION
   ============================================================ */
app.use("/auth", authRoutes);
app.use("/data", saveRoutes);

/* ============================================================
   📌 MULTER STORAGE
   ============================================================ */
const upload = multer({ dest: "uploads/" });

/* ============================================================
   📌 UPLOAD + SPLIT + TRANSCRIBE + SUMMARIZE + QUIZ GENERATE
   ============================================================ */
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const videoFile = req.file.path;
    const splitOutputDir = path.join("chunks", Date.now().toString());
    fs.mkdirSync(splitOutputDir);

    await splitVideo(videoFile, splitOutputDir);

    const chunkFiles = fs.readdirSync(splitOutputDir);

    const transcriptionPromises = chunkFiles.map(async (chunk) => {
      const response = await axios.post("http://worker:5001/process", {
        filePath: `${splitOutputDir}/${chunk}`,
      });
      return response.data.text;
    });

    const transcriptions = await Promise.all(transcriptionPromises);
    const finalText = transcriptions.join(" ");

    const summary = await summarizeText(finalText);
    const quiz = await generateQuiz(finalText);

    return res.json({ summary, fullText: finalText, quiz });
  } catch (err) {
    console.log("UPLOAD ERROR:", err);
    res.status(500).json({ error: true, message: "Upload processing failed" });
  }
});

/* ============================================================
   📌 FFmpeg SPLIT FUNCTION
   ============================================================ */
function splitVideo(input, outputDir) {
  return new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      input,
      "-f",
      "segment",
      "-segment_time",
      "300",
      "-reset_timestamps",
      "1",
      `${outputDir}/chunk_%03d.mp4`,
    ]);
    ffmpeg.on("exit", resolve);
  });
}

/* ============================================================
   📌 OPENAI SUMMARIZATION FUNCTION
   ============================================================ */
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
  return data.choices[0].message.content;
}

/* ============================================================
   📌 FIX QUIZ ANSWERS IF ALL INDEXES ARE SAME
   ============================================================ */
function fixQuizAnswers(quiz) {
  if (!Array.isArray(quiz)) return quiz;

  const indices = quiz.map(q => q.correct);
  const allSame = indices.every(i => i === indices[0]);

  if (allSame) {
    quiz.forEach(q => {
      const correctOption = q.options[q.correct];
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

/* ============================================================
   📌 OPENAI QUIZ GENERATION FUNCTION (WITH VALIDATION)
   ============================================================ */
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
          content: `You are a quiz generator. Based on the provided text, generate exactly 8 multiple-choice questions.
Each question must follow this structure exactly:
[{"question": string, "options": [string, string, string, string], "correct": number(index of options)}]

Rules:
- The correct answer must be one of the options.
- The "correct" index must accurately reflect which option is correct (0, 1, 2, or 3).
- The position of the correct answer MUST be random and MUST NOT always be 0.
- DO NOT repeat the same correct index for all questions.
- DO NOT include explanations, comments, or markdown. Return ONLY a valid JSON array.`
        },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await res.json();
  let quizText = data.choices[0]?.message?.content || "";
  console.log("GPT Response:", quizText);

  quizText = quizText.replace(/```json|```/g, "").trim();

  try {
    let parsedQuiz = JSON.parse(quizText);

    parsedQuiz = parsedQuiz.filter(q =>
      q.options?.length === 4 &&
      typeof q.correct === "number" &&
      q.correct >= 0 &&
      q.correct <= 3
    );

    return fixQuizAnswers(parsedQuiz);
  } catch (err) {
    console.error("Failed to parse quiz JSON:", quizText);
    return [];
  }
}

/* ============================================================
   📌 MONGODB CONNECTION
   ============================================================ */
console.log("MONGO_URI:", process.env.MONGO_URI);
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("DB connected"))
  .catch((err) => console.log(err));

/* ============================================================
   📌 ROOT ROUTE
   ============================================================ */
app.get("/", (req, res) => {
  res.send("LOOMIA API is running");
});

/* ============================================================
   🚀 START SERVER
   ============================================================ */
app.listen(5000, () => console.log("API running on port 5000"));
