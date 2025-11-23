import mongoose from "mongoose";

const dataSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  title: String,
  summary: String,
  transcript: String,   // ✅ add this
  quiz: Array,          // store your quiz array
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("SavedData", dataSchema);
