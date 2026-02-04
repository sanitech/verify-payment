import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';

import CBERouter from './routes/verifyCBERoute';
import telebirrRouter from './routes/verifyTelebirrRoute';
import dashenRouter from './routes/verifyDashenRoute';
import abyssiniaRouter from './routes/verifyAbyssiniaRoute';
import cbebirrRouter from './routes/verifyCBEBirrRoute';
import logger from './utils/logger';
import { verifyImageHandler } from './services/verifyImage';
import { requestLogger } from './middleware/requestLogger';

const app = express();

app.use(cors());
app.use(express.json());

// Add request logging middleware
app.use(requestLogger);

// Error handling for JSON parsing - properly typed as an error handler
const jsonErrorHandler: ErrorRequestHandler = async (err, req, res, next): Promise<void> => {
  if (err instanceof SyntaxError && 'body' in err) {
    logger.error('JSON parsing error:', err);
    res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
    return;
  }

  next(err);
};

app.use(jsonErrorHandler);

// Attach routers to paths
app.use('/verify-cbe', CBERouter);
app.use('/verify-telebirr', telebirrRouter);
app.use('/verify-dashen', dashenRouter);
app.use('/verify-abyssinia', abyssiniaRouter);
app.use('/verify-cbebirr', cbebirrRouter);
app.post('/verify-image', verifyImageHandler);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Payment Verification API',
    version: '2.1.0',
    endpoints: [
      '/verify-cbe',
      '/verify-telebirr',
      '/verify-dashen',
      '/verify-abyssinia',
      '/verify-cbebirr',
      '/verify-image'
    ]
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

export default app;
