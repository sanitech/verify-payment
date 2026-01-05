import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import UsageLog from '../models/UsageLog';

// In-memory cache for quick stats access
const statsCache = {
  totalRequests: 0,
  endpointStats: new Map<string, {
    count: number,
    successCount: number,
    failureCount: number,
    avgResponseTime: number
  }>(),
  ipStats: new Map<string, number>()
};

// Initialize cache from database on startup
export const initializeStatsCache = async () => {
  try {
    // Get total requests
    statsCache.totalRequests = await UsageLog.countDocuments();

    // Get endpoint stats using aggregation
    const endpointStats = await UsageLog.aggregate([
      {
        $group: {
          _id: { method: '$method', endpoint: '$endpoint' },
          count: { $sum: 1 },
          successCount: {
            $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] }
          },
          failureCount: {
            $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] }
          },
          avgResponseTime: { $avg: '$responseTime' }
        }
      }
    ]);

    // Populate cache
    endpointStats.forEach((stat: any) => {
      const endpoint = `${stat._id.method} ${stat._id.endpoint}`;
      statsCache.endpointStats.set(endpoint, {
        count: stat.count,
        successCount: stat.successCount,
        failureCount: stat.failureCount,
        avgResponseTime: stat.avgResponseTime
      });
    });

    // Get IP stats using aggregation
    const ipStatsValue = await UsageLog.aggregate([
      {
        $group: {
          _id: '$ip',
          count: { $sum: 1 }
        }
      }
    ]);

    ipStatsValue.forEach((stat: any) => {
      statsCache.ipStats.set(stat._id, stat.count);
    });

    logger.info('Stats cache initialized from database');
  } catch (error) {
    logger.error('Error initializing stats cache:', error);
  }
};

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(2, 15);

  // Log request details
  logger.info(`[${requestId}] Incoming ${req.method} request to ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    query: Object.keys(req.query).length ? req.query : undefined,
    apiKey: (req as any).apiKeyData ? (req as any).apiKeyData.owner : 'none'
  });

  // Update in-memory cache for quick access
  statsCache.totalRequests++;

  // Track by endpoint
  const endpoint = `${req.method} ${req.originalUrl.split('?')[0]}`;
  if (!statsCache.endpointStats.has(endpoint)) {
    statsCache.endpointStats.set(endpoint, {
      count: 0,
      successCount: 0,
      failureCount: 0,
      avgResponseTime: 0
    });
  }
  const endpointStat = statsCache.endpointStats.get(endpoint)!;
  endpointStat.count++;

  // Track by IP address
  const ipCount = statsCache.ipStats.get(req.ip ?? '') || 0;
  statsCache.ipStats.set(req.ip ?? '', ipCount + 1);

  // Use the 'finish' event to capture response completion
  res.on('finish', async () => {
    const responseTime = Date.now() - start;
    const endpointStat = statsCache.endpointStats.get(endpoint)!;

    if (res.statusCode < 400) {
      endpointStat.successCount++;
    } else {
      endpointStat.failureCount++;
    }

    endpointStat.avgResponseTime =
      (endpointStat.avgResponseTime * (endpointStat.count - 1) + responseTime) / endpointStat.count;

    logger.info(`[${requestId}] Response sent in ${responseTime}ms with status ${res.statusCode}`, {
      statusCode: res.statusCode,
      responseTime,
      contentLength: res.get('Content-Length') || 'unknown',
      apiKey: (req as any).apiKeyData?.key?.substring(0, 8) || 'none'
    });

    if (res.statusCode >= 400) {
      logger.warn(`[${requestId}] Error occurred with status ${res.statusCode}`);
    }

    // Store usage log in database if API key is present
    try {
      if ((req as any).apiKeyData) {
        await UsageLog.create({
          apiKeyId: (req as any).apiKeyData.id || (req as any).apiKeyData._id,
          endpoint,
          method: req.method,
          statusCode: res.statusCode,
          responseTime,
          ip: req.ip || 'unknown'
        });
      }
    } catch (error) {
      logger.error('Error logging API usage:', error);
    }
  });

  next();
};

// Get usage statistics with cache fallback
export const getUsageStats = async () => {
  try {
    // Try to get fresh data from database
    const totalRequests = await UsageLog.countDocuments();

    const endpointStats = await UsageLog.aggregate([
      {
        $group: {
          _id: { method: '$method', endpoint: '$endpoint' },
          count: { $sum: 1 },
          successCount: {
            $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] }
          },
          failureCount: {
            $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] }
          },
          avgResponseTime: { $avg: '$responseTime' }
        }
      }
    ]);

    const ipStatsValue = await UsageLog.aggregate([
      {
        $group: {
          _id: '$ip',
          count: { $sum: 1 }
        }
      }
    ]);

    // Convert raw results to proper format
    const formattedEndpointStats: Record<string, any> = {};
    endpointStats.forEach((stat: any) => {
      const endpoint = `${stat._id.method} ${stat._id.endpoint}`;
      formattedEndpointStats[endpoint] = {
        count: stat.count,
        successCount: stat.successCount,
        failureCount: stat.failureCount,
        avgResponseTime: stat.avgResponseTime
      };
    });

    const formattedIpStats: Record<string, number> = {};
    ipStatsValue.forEach((stat: any) => {
      formattedIpStats[stat._id] = stat.count;
    });

    return {
      totalRequests,
      endpointStats: formattedEndpointStats,
      ipStats: formattedIpStats
    };
  } catch (error) {
    logger.error('Error fetching usage stats from database:', error);

    // Fallback to in-memory cache if database query fails
    logger.info('Falling back to in-memory cache for stats');

    // Convert Maps to objects for JSON serialization
    const endpointStatsObj: Record<string, any> = {};
    statsCache.endpointStats.forEach((value, key) => {
      endpointStatsObj[key] = value;
    });

    const ipStatsObj: Record<string, number> = {};
    statsCache.ipStats.forEach((value, key) => {
      ipStatsObj[key] = value;
    });

    return {
      totalRequests: statsCache.totalRequests,
      endpointStats: endpointStatsObj,
      ipStats: ipStatsObj
    };
  }
};