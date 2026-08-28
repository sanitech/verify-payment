import { Router, Request, Response } from 'express';
import { verifyAbyssinia } from '../services/verifyAbyssinia';
import logger from '../utils/logger';

const router = Router();

router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const { reference } = req.body;

        if (!reference) {
            res.status(400).json({ success: false, error: 'Missing required parameter: reference' });
            return;
        }

        if (typeof reference !== 'string') {
            res.status(400).json({ success: false, error: 'Invalid parameter type: reference must be a string' });
            return;
        }

        const result = await verifyAbyssinia(reference);

        if (result.success) {
            res.json({ success: true, data: result });
        } else {
            res.status(404).json({ success: false, error: result.error || 'Transaction not found or verification failed' });
        }
    } catch (error) {
        logger.error('Error in Abyssinia verification route:', error);
        res.status(500).json({ success: false, error: 'Internal server error during verification' });
    }
});

router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const { reference } = req.query;

        if (!reference || typeof reference !== 'string') {
            res.status(400).json({ success: false, error: 'Missing required query parameter: reference' });
            return;
        }

        const result = await verifyAbyssinia(reference);

        if (result.success) {
            res.json({ success: true, data: result });
        } else {
            res.status(404).json({ success: false, error: result.error || 'Transaction not found or verification failed' });
        }
    } catch (error) {
        logger.error('Error in Abyssinia verification route (GET):', error);
        res.status(500).json({ success: false, error: 'Internal server error during verification' });
    }
});

export default router;
