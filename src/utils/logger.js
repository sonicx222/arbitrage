import winston from 'winston';
import config from '../config.js';
import fs from 'fs';
import path from 'path';

// Ensure logs directory exists
const logsDir = config.logging.directory;
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Define custom log levels and colors
const customLevels = {
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
        verbose: 4,
    },
    colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        debug: 'blue',
        verbose: 'gray',
    },
};

// Add colors to Winston
winston.addColors(customLevels.colors);

// Custom format for console output
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let msg = `${timestamp} [${level}] ${message}`;

        // Add metadata if present
        if (Object.keys(meta).length > 0) {
            msg += ` ${JSON.stringify(meta)}`;
        }

        return msg;
    })
);

// Format for file output (JSON)
const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// Create transports array
const transports = [];

// Only add console transport if not in test mode, or if explicitly enabled
if (process.env.NODE_ENV !== 'test' || process.env.LOG_IN_TESTS === 'true') {
    transports.push(
        new winston.transports.Console({
            format: consoleFormat,
            level: config.debugMode ? 'debug' : config.logging.level,
        })
    );
}

// Add file transports if enabled
if (config.logging.toFile) {
    transports.push(
        // Error log file
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),

        // Combined log file
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),

        // Arbitrage opportunities log
        new winston.transports.File({
            filename: path.join(logsDir, 'opportunities.log'),
            level: 'info',
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 10,
        })
    );
}

// Add a silent transport if no transports are configured (prevents Winston warnings in tests)
if (transports.length === 0) {
    transports.push(
        new winston.transports.Console({
            silent: true,
        })
    );
}

// Create the Winston logger
const logger = winston.createLogger({
    levels: customLevels.levels,
    transports,
    exitOnError: false,
});

// Create convenience methods for different log types
export const log = {
    error: (message, meta = {}) => logger.error(message, meta),
    warn: (message, meta = {}) => logger.warn(message, meta),
    info: (message, meta = {}) => logger.info(message, meta),
    debug: (message, meta = {}) => logger.debug(message, meta),
    verbose: (message, meta = {}) => logger.verbose(message, meta),

    // Special method for arbitrage opportunities
    opportunity: (opportunity) => {
        logger.info('🎯 Arbitrage Opportunity Detected', opportunity);
    },

    // Special method for performance metrics
    performance: (metrics) => {
        logger.info('📊 Performance Metrics', metrics);
    },

    // Special method for RPC issues
    rpc: (message, meta = {}) => {
        logger.warn(`🔌 RPC: ${message}`, meta);
    },

    // Special method for WebSocket events
    ws: (message, meta = {}) => {
        logger.debug(`🌐 WebSocket: ${message}`, meta);
    },
};

export default log;
