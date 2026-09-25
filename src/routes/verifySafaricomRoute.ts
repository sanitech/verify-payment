import { Router, Request, Response } from 'express';
import { verifySafaricom, verifySafaricomText } from '../services/verifySafaricom';
import logger from '../utils/logger';

const router = Router();

async function handle(reference: string | undefined, text: string | undefined, res: Response): Promise<void> {
    try {
        const result = reference
            ? await verifySafaricom(reference)
            : await verifySafaricomText(text as string);

        if (result.success) {
            res.json({ success: true, data: result });
        } else {
            res.status(404).json({ success: false, error: result.error });
        }
    } catch (error) {
        logger.error('Error in Safaricom verification route:', error);
        res.status(500).json({ success: false, error: 'Internal server error during verification' });
    }
}

router.post('/', async (req: Request, res: Response): Promise<void> => {
    const reference = typeof req.body?.reference === 'string' ? req.body.reference : undefined;
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;

    if (!reference && !text) {
        res.status(400).json({ success: false, error: 'Missing required parameter: reference or text' });
        return;
    }
    await handle(reference, text, res);
});

router.get('/', async (req: Request, res: Response): Promise<void> => {
    const reference = typeof req.query.reference === 'string' ? req.query.reference : undefined;
    const text = typeof req.query.text === 'string' ? req.query.text : undefined;

    if (!reference && !text) {
        res.status(400).json({ success: false, error: 'Missing required query parameter: reference or text' });
        return;
    }
    await handle(reference, text, res);
});

export default router;
