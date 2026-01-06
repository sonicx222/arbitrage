/**
 * Message types for worker thread communication
 *
 * Used for communication between main thread (WorkerCoordinator)
 * and worker threads (ChainWorker)
 */

export const MessageType = {
    // Worker lifecycle
    INITIALIZE: 'INITIALIZE',
    INITIALIZED: 'INITIALIZED',
    START: 'START',
    STARTED: 'STARTED',
    STOP: 'STOP',
    STOPPED: 'STOPPED',

    // Status
    GET_STATUS: 'GET_STATUS',
    STATUS: 'STATUS',
    HEARTBEAT: 'HEARTBEAT',

    // Data
    OPPORTUNITIES: 'OPPORTUNITIES',
    PRICES: 'PRICES',
    BLOCK: 'BLOCK',

    // Execution
    EXECUTE: 'EXECUTE',
    EXECUTION_RESULT: 'EXECUTION_RESULT',

    // Errors
    ERROR: 'ERROR',
    WARNING: 'WARNING',

    // Configuration
    UPDATE_CONFIG: 'UPDATE_CONFIG',
    CONFIG_UPDATED: 'CONFIG_UPDATED',
};

/**
 * Create a standardized message object
 * @param {string} type - Message type from MessageType enum
 * @param {Object} data - Message payload
 * @param {Object} meta - Optional metadata
 * @returns {Object} Formatted message
 */
export function createMessage(type, data = {}, meta = {}) {
    return {
        type,
        data,
        meta: {
            ...meta,
            timestamp: Date.now(),
        },
    };
}

/**
 * Validate a message has required fields
 * @param {Object} message - Message to validate
 * @returns {boolean} True if valid
 */
export function isValidMessage(message) {
    return (
        message &&
        typeof message === 'object' &&
        typeof message.type === 'string' &&
        Object.values(MessageType).includes(message.type)
    );
}

export default MessageType;
