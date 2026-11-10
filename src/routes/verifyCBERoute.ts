import { Router, Request, Response } from 'express';
import { verifyCBE } from '../services/verifyCBE';
import { verifyCBEReceiptText } from '../services/verifyCBEReceipt';
import logger from '../utils/logger';

const router = Router();

interface VerifyRequestBody {
    reference?: string;
    accountSuffix?: string;
    // The pasted CBE SMS or its mbreciept.cbe.com.et link. Needs no account suffix.
    text?: string;
    url?: string;
}

// SMS / receipt link: { text } (or { url }) -> { success, data: { reference, receiver, receiverAccount, amount, date, ... } }
async function handleReceiptText(text: unknown, res: Response): Promise<void> {
    if (typeof text !== 'string') {
        res.status(400).json({ success: false, error: 'Invalid parameter type: text must be a string' });
        return;
    }
    try {
        const result = await verifyCBEReceiptText(text);
        if (result.success) {
            res.json({ success: true, data: result });
        } else {
            res.status(404).json({ success: false, error: result.error || 'Transaction not found or verification failed' });
        }
    } catch (err) {
        logger.error('Error in CBE receipt verification route:', err);
        res.status(500).json({ success: false, error: 'Internal server error during verification' });
    }
}

router.post('/', async function (
    req: Request<{}, {}, VerifyRequestBody>,
    res: Response
): Promise<void> {
    const { reference, accountSuffix, text, url } = req.body;

    if (text !== undefined || url !== undefined) {
        await handleReceiptText(text ?? url, res);
        return;
    }

    if (!reference || !accountSuffix) {
        res.status(400).json({ success: false, error: 'Missing reference or accountSuffix, or send text with the CBE receipt link.' });
        return;
    }

    try {
        const result = await verifyCBE(reference, accountSuffix);
        res.json(result);
    } catch (err) {
        logger.error("💥 Payment verification failed:", err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

router.get('/', async function(
    req: Request<{}, {}, {}, { reference?: string; accountSuffix?: string; text?: string; url?: string }>,
    res: Response
): Promise<void> {
    const { reference, accountSuffix, text, url } = req.query;

    if (text !== undefined || url !== undefined) {
        await handleReceiptText(text ?? url, res);
        return;
    }

    if (typeof reference !== 'string' || typeof accountSuffix !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid query parameters.' });
        return;
    }

    try {
        const result = await verifyCBE(reference, accountSuffix);
        res.json(result);
    } catch (err) {
        logger.error(err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

export default router;
