import { requireAuth } from "../middlewares/requireAuth.js";
import { Router } from "express";

const router = Router();

router.get("/dashboard", requireAuth, async (req, res) => {
    // Only reached when a valid session exists, so userId is set
    const userId = req.session.userId!;

    // ...load this user's data...
    return res.status(200).json({ message: "Welcome to your dashboard", userId });
});

export default router;