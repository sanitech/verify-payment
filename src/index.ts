import dotenv from 'dotenv';
import logger from './utils/logger';
import app from './app';

dotenv.config();

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

const gracefulShutdown = () => {
  logger.info('Shutting down server...');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
