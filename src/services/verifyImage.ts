import { Mistral } from "@mistralai/mistralai";
import fs from "fs";
import { Request, Response } from "express";
import multer from "multer";
import logger from "../utils/logger";
import { verifyTelebirr } from "./verifyTelebirr";
import { verifyCBE } from "./verifyCBE";
import dotenv from "dotenv";

dotenv.config();

const upload = multer({ dest: "uploads/" });

// Initialize Mistral client only if API key is available
const client = process.env.MISTRAL_API_KEY ? new Mistral({
    apiKey: process.env.MISTRAL_API_KEY,
}) : null;

export const verifyImageHandler = [
    upload.single("file"),

    async (req: Request, res: Response): Promise<void> => {
        try {
            const autoVerify = req.query.autoVerify === "true";
            const accountSuffix = req.body?.suffix || null;

            if (!req.file) {
                logger.warn("No file uploaded");
                res.status(400).json({ error: "No file uploaded" });
                return;
            }

            const filePath = req.file.path;
            const imageBuffer = fs.readFileSync(filePath);
            
            // Get basic file information
            const fileSize = req.file.size;
            const mimeType = req.file.mimetype;
            
            logger.info(`Image uploaded: ${req.file.originalname}, Size: ${fileSize} bytes, Type: ${mimeType}`);

            // Check if Mistral AI is available for OCR
            if (!client) {
                // Fallback response when no API key is available
                res.json({
                    success: true,
                    message: "Image uploaded successfully. OCR analysis is currently disabled.",
                    fileInfo: {
                        originalName: req.file.originalname,
                        size: fileSize,
                        mimeType: mimeType,
                        uploadedAt: new Date().toISOString()
                    },
                    nextSteps: {
                        instruction: "Please enter the transaction reference number manually.",
                        telebirrEndpoint: "/verify-telebirr",
                        cbeEndpoint: "/verify-cbe",
                        dashenEndpoint: "/verify-dashen",
                        abyssiniaEndpoint: "/verify-abyssinia",
                        cbebirrEndpoint: "/verify-cbebirr"
                    },
                    note: "OCR functionality requires Mistral AI API key. Without it, please verify transactions using the reference numbers from your receipt."
                });
                return;
            }

            // Use Mistral AI for OCR analysis
            const base64Image = imageBuffer.toString("base64");

            const prompt = `
You are a payment receipt analyzer. Based on the uploaded image, determine:
- If the receipt was issued by Telebirr or the Commercial Bank of Ethiopia (CBE).
- If it's a CBE receipt, extract the transaction ID (usually starts with 'FT').
- If it's a Telebirr receipt, extract the transaction number (usually starts with 'CE').

Rules:
- CBE receipts usually include a purple header with the title "Commercial Bank of Ethiopia" and a structured table.
- Telebirr receipts are typically green with a large minus sign before the amount.
- CBE receipts may mention Telebirr (as the receiver) but are still CBE receipts.

Return this JSON format exactly:
{
  "type": "telebirr" | "cbe",
  "transaction_id"?: "FTxxxx" (if CBE),
  "transaction_number"?: "CExxxx" (if Telebirr)
}
            `.trim();

            logger.info("Sending image to Mistral Vision...");

            const chatResponse = await client.chat.complete({
                model: "pixtral-12b",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            {
                                type: "image_url",
                                imageUrl: `data:image/jpeg;base64,${base64Image}`,
                            },
                        ],
                    },
                ],
                responseFormat: { type: "json_object" },
            });

            const messageContent = chatResponse.choices?.[0]?.message?.content;

            if (!messageContent || typeof messageContent !== "string") {
                logger.error("Invalid Mistral response", { messageContent });
                res.status(500).json({ error: "Invalid OCR response" });
                return;
            }

            const result = JSON.parse(messageContent);
            logger.info("OCR Result", result);

            if (result.type === "telebirr" && result.transaction_number) {
                if (autoVerify) {
                    try {
                        const data = await verifyTelebirr(result.transaction_number);
                        res.json({
                            verified: true,
                            type: "telebirr",
                            reference: result.transaction_number,
                            details: data,
                        });
                    } catch (verifyErr) {
                        logger.error("Telebirr verification failed", { verifyErr });
                        res.status(500).json({ error: "Verification failed for Telebirr" });
                    }
                } else {
                    res.json({
                        type: "telebirr",
                        reference: result.transaction_number,
                        forward_to: "/verify-telebirr",
                    });
                }
                return;
            }

            if (result.type === "cbe" && result.transaction_id) {
                if (!autoVerify) {
                    res.json({
                        type: "cbe",
                        reference: result.transaction_id,
                        forward_to: "/verify-cbe",
                        accountSuffix: "required_from_user",
                    });
                    return;
                }

                if (!accountSuffix) {
                    res.status(400).json({
                        error: "Account suffix is required for CBE verification in autoVerify mode",
                    });
                    return;
                }

                try {
                    const data = await verifyCBE(result.transaction_id, accountSuffix);
                    res.json({
                        verified: true,
                        type: "cbe",
                        reference: result.transaction_id,
                        details: data,
                    });
                } catch (verifyErr) {
                    logger.error("CBE verification failed", { verifyErr });
                    res.status(500).json({ error: "Verification failed for CBE" });
                }
                return;
            }

            res.status(422).json({ error: "Unknown or unrecognized receipt type" });
        } catch (err) {
            logger.error(`Unexpected error in /verify-image: ${err instanceof Error ? err.message : String(err)}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
            res.status(500).json({ error: "Something went wrong processing the image." });
        } finally {
            if (req.file?.path) {
                fs.unlinkSync(req.file.path);
                logger.debug("Temp file deleted", { path: req.file.path });
            }
        }
    },
];
