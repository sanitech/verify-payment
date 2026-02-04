import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(2, 10);

  logger.info(`[${requestId}] ${req.method} ${req.originalUrl} – incoming request`, {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    headers: req.headers
  });

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`[${requestId}] Response ${res.statusCode} sent in ${duration}ms for ${req.method} ${req.originalUrl}`, {
      statusCode: res.statusCode,
      duration,
      contentLength: res.get('Content-Length')
    });
  });

  next();
};
