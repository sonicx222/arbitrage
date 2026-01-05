import axios from 'axios';
import chalk from 'chalk';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Alert Manager - Multi-channel notification system for arbitrage opportunities
 */
class AlertManager {
    constructor() {
        this.enabledChannels = {
            console: config.alerts.console,
            discord: config.alerts.discord,
            telegram: config.alerts.telegram,
        };

        // Cooldown tracking to avoid spam
        this.lastAlertTime = new Map(); // pairKey -> timestamp
        this.cooldownMs = config.alerts.cooldownMs;

        log.info('Alert Manager initialized', {
            channels: Object.entries(this.enabledChannels)
                .filter(([_, enabled]) => enabled)
                .map(([channel]) => channel),
        });
    }

    /**
     * Send alert for an arbitrage opportunity
     */
    async notify(opportunity) {
        const { pairKey } = opportunity;

        // Check cooldown
        if (this.isOnCooldown(pairKey)) {
            log.debug(`Alert cooldown active for ${pairKey}, skipping`);
            return;
        }

        // Log the opportunity
        log.opportunity(opportunity);

        // Send to all enabled channels
        const promises = [];

        if (this.enabledChannels.console) {
            this.sendConsoleAlert(opportunity);
        }

        if (this.enabledChannels.discord) {
            promises.push(this.sendDiscordAlert(opportunity));
        }

        if (this.enabledChannels.telegram) {
            promises.push(this.sendTelegramAlert(opportunity));
        }

        // Wait for all webhooks to complete
        await Promise.allSettled(promises);

        // Update cooldown
        this.lastAlertTime.set(pairKey, Date.now());
    }

    /**
     * Check if pair is on cooldown
     */
    isOnCooldown(pairKey) {
        const lastAlert = this.lastAlertTime.get(pairKey);
        if (!lastAlert) {
            return false;
        }

        const timeSinceLastAlert = Date.now() - lastAlert;
        return timeSinceLastAlert < this.cooldownMs;
    }

    /**
     * Send console alert with color coding
     */
    sendConsoleAlert(opp) {
        const profitColor = opp.netProfitPercentage > 5 ? 'green' :
            opp.netProfitPercentage > 2 ? 'yellow' : 'white';

        console.log('\n' + '='.repeat(60));
        console.log(chalk.bold.cyan('🎯 ARBITRAGE OPPORTUNITY DETECTED'));
        console.log('='.repeat(60));
        console.log(chalk.bold(`Pair: ${opp.tokenA}/${opp.tokenB}`));
        console.log(chalk.blue(`Buy on ${opp.buyDex}: ${opp.buyPrice.toFixed(6)}`));
        console.log(chalk.green(`Sell on ${opp.sellDex}: ${opp.sellPrice.toFixed(6)}`));
        console.log(chalk[profitColor].bold(`Est. Profit: $${(opp.profitUSD || 0).toFixed(2)} (${opp.netProfitPercentage.toFixed(2)}% ROI)`));
        console.log(chalk.white(`Trade Size: $${(opp.optimalTradeSizeUSD || 0).toFixed(2)}`));
        console.log(chalk.gray(`Fees: ${opp.totalFeePercentage.toFixed(2)}% | Gas: $${(opp.gasCostUSD || 0).toFixed(2)}`));
        console.log(chalk.gray(`Liquidity: $${opp.minLiquidity.toFixed(0)}`));
        console.log(chalk.gray(`Timestamp: ${new Date(opp.timestamp).toLocaleTimeString()}`));
        console.log('='.repeat(60) + '\n');
    }

    /**
     * Send Discord webhook alert
     */
    async sendDiscordAlert(opp) {
        try {
            const webhook = config.alerts.webhooks.discord;

            if (!webhook) {
                return;
            }

            const embed = {
                title: '🎯 Arbitrage Opportunity',
                color: opp.netProfitPercentage > 2 ? 0x00ff00 : // Green
                    opp.netProfitPercentage > 1 ? 0xffff00 : // Yellow
                        0xffffff, // White
                fields: [
                    {
                        name: 'Pair',
                        value: `${opp.tokenA}/${opp.tokenB}`,
                        inline: true,
                    },
                    {
                        name: 'Net Profit',
                        value: `**${opp.netProfitPercentage.toFixed(2)}%**`,
                        inline: true,
                    },
                    {
                        name: 'Buy',
                        value: `${opp.buyDex}: ${opp.buyPrice.toFixed(6)}`,
                        inline: false,
                    },
                    {
                        name: 'Sell',
                        value: `${opp.sellDex}: ${opp.sellPrice.toFixed(6)}`,
                        inline: false,
                    },
                    {
                        name: 'Liquidity',
                        value: `$${opp.minLiquidity.toFixed(0)}`,
                        inline: true,
                    },
                    {
                        name: 'Fees',
                        value: `${opp.totalFeePercentage.toFixed(2)}%`,
                        inline: true,
                    },
                ],
                timestamp: new Date(opp.timestamp).toISOString(),
                footer: {
                    text: 'BSC Arbitrage Bot',
                },
            };

            await axios.post(webhook, {
                embeds: [embed],
            });

            log.debug('Discord alert sent');

        } catch (error) {
            log.error('Failed to send Discord alert', { error: error.message });
        }
    }

    /**
     * Send Telegram alert
     */
    async sendTelegramAlert(opp) {
        try {
            const { botToken, chatId } = config.alerts.webhooks.telegram;

            if (!botToken || !chatId) {
                return;
            }

            const message = `
🎯 *ARBITRAGE OPPORTUNITY*

*Pair:* ${opp.tokenA}/${opp.tokenB}
*Net Profit:* ${opp.netProfitPercentage.toFixed(2)}%

*Buy on ${opp.buyDex}:* ${opp.buyPrice.toFixed(6)}
*Sell on ${opp.sellDex}:* ${opp.sellPrice.toFixed(6)}

*Liquidity:* $${opp.minLiquidity.toFixed(0)}
*Fees:* ${opp.totalFeePercentage.toFixed(2)}%
*Time:* ${new Date(opp.timestamp).toLocaleTimeString()}
      `.trim();

            const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

            await axios.post(url, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
            });

            log.debug('Telegram alert sent');

        } catch (error) {
            log.error('Failed to send Telegram alert', { error: error.message });
        }
    }

    /**
     * Send a test alert to verify configuration
     */
    async sendTestAlert() {
        const testOpportunity = {
            pairKey: 'WBNB/BUSD',
            tokenA: 'WBNB',
            tokenB: 'BUSD',
            buyDex: 'pancakeswap',
            sellDex: 'biswap',
            buyPrice: 310.5,
            sellPrice: 312.7,
            grossProfitPercentage: 0.71,
            netProfitPercentage: 0.36,
            totalFeePercentage: 0.35,
            gasCostBNB: 0.0015,
            minLiquidity: 150000,
            buyLiquidity: 200000,
            sellLiquidity: 150000,
            timestamp: Date.now(),
        };

        log.info('Sending test alert...');
        await this.notify(testOpportunity);
        log.info('Test alert sent successfully');
    }
}

// Export singleton instance
const alertManager = new AlertManager();
export default alertManager;
