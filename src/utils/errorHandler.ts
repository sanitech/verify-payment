import logger from './logger';
import { Response } from 'express';
import mongoose from 'mongoose';

// Error types for better error handling
export enum ErrorType {
    NOT_FOUND = 'NOT_FOUND',
    VALIDATION = 'VALIDATION',
    UNAUTHORIZED = 'UNAUTHORIZED',
    FORBIDDEN = 'FORBIDDEN',
    DATABASE = 'DATABASE',
    INTERNAL = 'INTERNAL',
}

// Custom error class with type and status code
export class AppError extends Error {
    type: ErrorType;
    statusCode: number;
    details?: any;

    constructor(message: string, type: ErrorType, statusCode: number, details?: any) {
        super(message);
        this.type = type;
        this.statusCode = statusCode;
        this.details = details;
        this.name = 'AppError';
    }
}

// Handle MongoDB/Mongoose specific errors
export const handleDatabaseError = (error: any): AppError => {
    if (error.name === 'MongoServerError' || error.name === 'ValidationError' || error.name === 'CastError') {
        // Handle unique constraint violation (code 11000 in MongoDB)
        if (error.code === 11000) {
            return new AppError(
                'A record with this value already exists.',
                ErrorType.VALIDATION,
                409,
                { fields: error.keyPattern }
            );
        }

        // Handle Mongoose validation errors
        if (error.name === 'ValidationError') {
            return new AppError(
                'Invalid data provided.',
                ErrorType.VALIDATION,
                400,
                { errors: error.errors }
            );
        }

        // Handle Mongoose cast errors (invalid ID format)
        if (error.name === 'CastError') {
            return new AppError(
                `Invalid value for field ${error.path}: ${error.value}`,
                ErrorType.VALIDATION,
                400
            );
        }

        logger.error(`Unhandled Database error: ${error.name}`, error);
        return new AppError(
            'Database operation failed.',
            ErrorType.DATABASE,
            500
        );
    } else if (error instanceof AppError) {
        // Pass through our custom errors
        return error;
    } else {
        // Handle unknown errors
        logger.error('Unknown error:', error);
        return new AppError(
            'An unexpected error occurred.',
            ErrorType.INTERNAL,
            500
        );
    }
};

// Send error response
export const sendErrorResponse = (res: Response, error: any) => {
    const appError = handleDatabaseError(error);

    res.status(appError.statusCode).json({
        success: false,
        error: appError.message,
        ...(process.env.NODE_ENV === 'development' && { details: appError.details })
    });
};