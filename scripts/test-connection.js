import { ethers } from 'ethers';
import config from '../src/config.js';
import chalk from 'chalk';

console.log(chalk.bold.cyan('🔍 Testing RPC Connectivity'));
console.log('='.repeat(60));
console.log();

async function testEndpoints() {
    console.log(chalk.bold('Testing HTTP RPC endpoints...'));
    console.log();

    let httpSuccess = 0;
    let httpFailed = 0;

    for (const endpoint of config.rpc.http) {
        try {
            const provider = new ethers.JsonRpcProvider(endpoint);
            const start = Date.now();
            const blockNumber = await provider.getBlockNumber();
            const duration = Date.now() - start;

            console.log(chalk.green('✅'), endpoint);
            console.log(chalk.gray(`   Block: ${blockNumber} | Response time: ${duration}ms`));
            console.log();
            httpSuccess++;
        } catch (error) {
            console.log(chalk.red('❌'), endpoint);
            console.log(chalk.gray(`   Error: ${error.message}`));
            console.log();
            httpFailed++;
        }
    }

    console.log(chalk.bold('Testing WebSocket endpoints...'));
    console.log();

    let wsSuccess = 0;
    let wsFailed = 0;

    for (const endpoint of config.rpc.ws) {
        try {
            const provider = new ethers.WebSocketProvider(endpoint);
            const start = Date.now();
            const blockNumber = await provider.getBlockNumber();
            const duration = Date.now() - start;

            console.log(chalk.green('✅'), endpoint);
            console.log(chalk.gray(`   Block: ${blockNumber} | Response time: ${duration}ms`));
            console.log();
            wsSuccess++;

            await provider.destroy();
        } catch (error) {
            console.log(chalk.red('❌'), endpoint);
            console.log(chalk.gray(`   Error: ${error.message}`));
            console.log();
            wsFailed++;
        }
    }

    console.log('='.repeat(60));
    console.log(chalk.bold('Summary:'));
    console.log(chalk.green(`  HTTP: ${httpSuccess} working, ${httpFailed} failed`));
    console.log(chalk.green(`  WebSocket: ${wsSuccess} working, ${wsFailed} failed`));
    console.log();

    if (httpSuccess === 0) {
        console.log(chalk.red('⚠️  No HTTP endpoints working! Bot will not function.'));
        process.exit(1);
    }

    if (wsSuccess === 0) {
        console.log(chalk.yellow('⚠️  No WebSocket endpoints working! Bot will not receive real-time blocks.'));
        console.log(chalk.yellow('   Consider adding different WebSocket endpoints to .env'));
    }

    process.exit(0);
}

testEndpoints().catch(error => {
    console.error(chalk.red('Fatal error:'), error.message);
    process.exit(1);
});
