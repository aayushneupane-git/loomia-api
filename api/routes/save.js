import express from "express";
import SavedData from "../models/SavedData.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

// Save data
router.post("/save", authMiddleware, async (req, res) => {
  const { title, summary, quiz,transcript } = req.body;

  const saved = await SavedData.create({
    userId: req.userId,
    title,
    summary,
    transcript,
    quiz
  });

  res.json({ message: "Saved!", saved });
});

// Get user saved data
router.get("/mydata", authMiddleware, async (req, res) => {
  const data = await SavedData.find({ userId: req.userId });
  res.json(data);
});

export default router;
