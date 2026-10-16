import { Router, Request, Response } from 'express';
import { verifyAbyssinia, verifyAbyssiniaText } from '../services/verifyAbyssinia';
import logger from '../utils/logger';

const router = Router();

async function handle(reference: unknown, text: unknown, res: Response): Promise<void> {
    try {
        if (reference === undefined && text === undefined) {
            res.status(400).json({ success: false, error: 'Missing required parameter: reference or text' });
            return;
        }
        if ((reference !== undefined && typeof reference !== 'string') || (text !== undefined && typeof text !== 'string')) {
            res.status(400).json({ success: false, error: 'Invalid parameter type: reference and text must be strings' });
            return;
        }

        const result = reference ? await verifyAbyssinia(reference as string) : await verifyAbyssiniaText(text as string);

        if (result.success) {
            res.json({ success: true, data: result });
        } else {
            res.status(404).json({ success: false, error: result.error || 'Transaction not found or verification failed' });
        }
    } catch (error) {
        logger.error('Error in Abyssinia verification route:', error);
        res.status(500).json({ success: false, error: 'Internal server error during verification' });
    }
}

router.post('/', (req: Request, res: Response) => handle(req.body?.reference, req.body?.text, res));
router.get('/', (req: Request, res: Response) => handle(req.query.reference, req.query.text, res));

export default router;
