"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const serverless_http_1 = __importDefault(require("serverless-http"));
const app_1 = __importDefault(require("../src/app"));
const logger_1 = __importDefault(require("../src/utils/logger"));
const db_1 = require("../src/utils/db");
const requestLogger_1 = require("../src/middleware/requestLogger");
dotenv_1.default.config();
let initPromise = null;
const ensureInit = async () => {
    if (!initPromise) {
        initPromise = (async () => {
            await (0, db_1.connectDB)();
            await (0, requestLogger_1.initializeStatsCache)();
        })();
    }
    await initPromise;
};
const handler = (0, serverless_http_1.default)(app_1.default);
exports.default = async (req, res) => {
    try {
        await ensureInit();
    }
    catch (error) {
        logger_1.default.error('Vercel server initialization failed:', error);
        res.status(500).json({ success: false, error: 'Server initialization failed' });
        return;
    }
    return handler(req, res);
};
