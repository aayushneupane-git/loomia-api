import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Users from "../models/Users.js";
const router = express.Router();

// Signup
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const hashedPass = await bcrypt.hash(password, 10);
    const newUser = await Users.create({ name, email, password: hashedPass });

    res.json({ message: "User Registered!" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await Users.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Wrong password" });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d"
    });

    res.json({ token, user:user.email, name: user.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
