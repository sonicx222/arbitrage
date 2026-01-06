import log from '../utils/logger.js';

/**
 * Factory for creating chain instances
 * Dynamically loads and instantiates chain implementations
 */
class ChainFactory {
    constructor() {
        // Registry of chain implementations
        this.chainRegistry = new Map();

        // Chain ID to implementation mapping
        this.chainIdMap = {
            56: 'bsc',
            1: 'ethereum',
            137: 'polygon',
            42161: 'arbitrum',
            8453: 'base',
            43114: 'avalanche',
        };
    }

    /**
     * Register a chain implementation
     * @param {string} chainName - Name of the chain (e.g., 'bsc', 'ethereum')
     * @param {Function} ChainClass - Chain class constructor
     */
    register(chainName, ChainClass) {
        this.chainRegistry.set(chainName.toLowerCase(), ChainClass);
        log.debug(`Registered chain implementation: ${chainName}`);
    }

    /**
     * Create a chain instance
     * @param {number|string} chainIdOrName - Chain ID or name
     * @param {Object} config - Chain configuration
     * @returns {BaseChain} Chain instance
     */
    async create(chainIdOrName, config) {
        // Resolve chain name from ID if needed
        let chainName;
        if (typeof chainIdOrName === 'number') {
            chainName = this.chainIdMap[chainIdOrName];
            if (!chainName) {
                throw new Error(`Unknown chain ID: ${chainIdOrName}`);
            }
        } else {
            chainName = chainIdOrName.toLowerCase();
        }

        // Check if implementation is registered
        let ChainClass = this.chainRegistry.get(chainName);

        // Lazy load if not registered
        if (!ChainClass) {
            ChainClass = await this.loadChainImplementation(chainName);
            if (ChainClass) {
                this.register(chainName, ChainClass);
            }
        }

        if (!ChainClass) {
            throw new Error(`No implementation found for chain: ${chainName}`);
        }

        // Create instance
        const instance = new ChainClass(config);
        log.info(`Created chain instance: ${chainName} (ID: ${config.chainId})`);

        return instance;
    }

    /**
     * Dynamically load a chain implementation
     * @param {string} chainName - Chain name
     * @returns {Function|null} Chain class or null
     */
    async loadChainImplementation(chainName) {
        try {
            // Capitalize first letter for class name
            const className = chainName.charAt(0).toUpperCase() + chainName.slice(1) + 'Chain';
            const modulePath = `./implementations/${className}.js`;

            const module = await import(modulePath);
            return module.default;
        } catch (error) {
            log.warn(`Could not load chain implementation: ${chainName}`, { error: error.message });
            return null;
        }
    }

    /**
     * Create multiple chain instances
     * @param {Object} chainConfigs - Map of chainId -> config
     * @returns {Map<number, BaseChain>} Map of chain instances
     */
    async createAll(chainConfigs) {
        const chains = new Map();

        for (const [chainId, config] of Object.entries(chainConfigs)) {
            if (!config.enabled) {
                log.info(`Skipping disabled chain: ${config.name || chainId}`);
                continue;
            }

            try {
                const chain = await this.create(parseInt(chainId), config);
                chains.set(parseInt(chainId), chain);
            } catch (error) {
                log.error(`Failed to create chain ${chainId}`, { error: error.message });
            }
        }

        return chains;
    }

    /**
     * Get chain name from ID
     * @param {number} chainId - Chain ID
     * @returns {string|null} Chain name
     */
    getChainName(chainId) {
        return this.chainIdMap[chainId] || null;
    }

    /**
     * Get chain ID from name
     * @param {string} chainName - Chain name
     * @returns {number|null} Chain ID
     */
    getChainId(chainName) {
        for (const [id, name] of Object.entries(this.chainIdMap)) {
            if (name.toLowerCase() === chainName.toLowerCase()) {
                return parseInt(id);
            }
        }
        return null;
    }

    /**
     * Get all supported chain IDs
     * @returns {Array<number>} Array of chain IDs
     */
    getSupportedChainIds() {
        return Object.keys(this.chainIdMap).map(id => parseInt(id));
    }

    /**
     * Check if a chain is supported
     * @param {number|string} chainIdOrName - Chain ID or name
     * @returns {boolean} True if supported
     */
    isSupported(chainIdOrName) {
        if (typeof chainIdOrName === 'number') {
            return this.chainIdMap.hasOwnProperty(chainIdOrName);
        }
        return Object.values(this.chainIdMap).includes(chainIdOrName.toLowerCase());
    }
}

// Export singleton factory instance
const chainFactory = new ChainFactory();
export default chainFactory;

// Also export class for testing
export { ChainFactory };
