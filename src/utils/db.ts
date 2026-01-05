import mongoose from 'mongoose';
import logger from './logger';

const MONGODB_URI = process.env.DATABASE_URL || 'mongodb://localhost:27017/verifier_api';

export const connectDB = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        logger.info('Connected to MongoDB successfully');
    } catch (error) {
        logger.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
};

export const disconnectDB = async () => {
    try {
        await mongoose.disconnect();
        logger.info('Disconnected from MongoDB');
    } catch (error) {
        logger.error('Error disconnecting from MongoDB:', error);
    }
};
