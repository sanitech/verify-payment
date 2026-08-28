import { Router, Request, Response } from "express";
import { verifyEbirrText, EbirrWallet } from "../services/verifyEbirr";

const router = Router();

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const wallet = req.body?.wallet as EbirrWallet | undefined;
  if (wallet && wallet !== "kaafimf" && wallet !== "coopay") {
    res.status(400).json({ success: false, error: "wallet must be kaafimf or coopay" });
    return;
  }
  if (!text) {
    res.status(400).json({ success: false, error: "text is required" });
    return;
  }
  try {
    const result = await verifyEbirrText(text, wallet);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error instanceof Error ? error.message : "eBirr receipt could not be verified",
    });
  }
});

export default router;
