import fs from 'fs';
import { program } from 'commander';
import { ethers } from 'ethers';
import _ from 'lodash';
import { PerpsMarketAdapter, PerpsMarketInfo, TradeOptions } from 'types';

import { sleep, timelog } from './async-utils';
import UniswapExchange from './exchangers/uniswap';
import BybitPerpMarket from './perp-markets/bybit';
import SynthetixPerpsMarket from './perp-markets/synthetix';

program
    .name('beasynthbot')
    .description('Simple example perpetual futures arbitrage automation bot')
    .requiredOption('-s --symbol <name>', 'The currency symbol to trade. example: ETH')
    .requiredOption('-l --leverage <value>', 'The amount of leverage')
    .option('-r --rebalance-threshold <value>', 'The of deviance from the target at which the markets should be rebalanced', '0.1')
    .option('--min-profit-time <seconds>', 'The number of seconds that a funding rate should be favorable before taking a trade', '3600')
    .option('--dev-address <address>', 'The address of the developer who made this bot', 'dbeal.eth')
    .option('--dev-tip <ratio>', 'Ratio of profit to send to the creator of this tool. 1 = tip everything, 0 = tip nothing', '0.1')
    .option('--period <seconds>', 'Number of seconds between checking the status of the bot', '60')
    .option('--state <file>', 'Where to save the current state in case of program restart', 'state.json')
    .showHelpAfterError(true)
    .action(async (opts) => {

        console.log('');
        console.log('beasynthbot  Copyright (C) 2023  Daniel Beal');
        console.log('This program comes with ABSOLUTELY NO WARRANTY; see LICENSE for more information.');
        console.log('This is free software, and you are welcome to redistribute it');
        console.log('under certain conditions; see LICENSE for details.');
        console.log('');

        timelog('got opts', opts);



        if (!process.env.ARB_PROVIDER_URL) {
            throw new Error('please set ARB_PROVIDER_URL to specify the url of the EVM chain you are trading between');
        }
        
        if (!process.env.ARB_PRIVATE_KEY) {
            throw new Error('please set ARB_PRIVATE_KEY to specify the address with funds for the arbitrage');
        }

        if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
            throw new Error('please set BYBIT_API_KEY and BYBIT_API_SECRET to specify the API credentials for your bybit account');
        }

        // make the wallet
        const provider = new ethers.JsonRpcProvider(process.env.ARB_PROVIDER_URL);
        const wallet = new ethers.Wallet(process.env.ARB_PRIVATE_KEY, provider);

        // make the perp market adapters
        const allPerpsMarkets: { [name: string]: PerpsMarketAdapter } = {
            'snx': new SynthetixPerpsMarket(wallet),
            'bybit': new BybitPerpMarket(provider, process.env.BYBIT_API_KEY, process.env.BYBIT_API_SECRET),
        };

        // every time the program is started, the app will make a new trade just to mak esure things are in a safe state
        let currentTrade: null | { longMarket: string, shortMarket: string, startBalance: number } = 
            fs.existsSync(opts.state) ? 
            JSON.parse(fs.readFileSync(opts.state).toString()) :
            null;

        const calculateTotalBalance = async function() {
            let totalBalance = 0;
            for (const n in allPerpsMarkets) {
                totalBalance += await allPerpsMarkets[n].getBalance([opts.symbol]);
            }

            return totalBalance;
        }

        timelog('my wallet address is', wallet.address);
        timelog('enter loop');
        while (true) {
            try {
                if (!currentTrade) {
                    const totalBalance = await calculateTotalBalance();
    
                    timelog(`current balance ${totalBalance}`);
    
                    const estimatedAmount = opts.leverage * totalBalance / await allPerpsMarkets[Object.keys(allPerpsMarkets)[0]].getPrice(opts.symbol) / 2;
    
                    timelog(`estimated trade size ${estimatedAmount} ${opts.symbol} (= ${opts.leverage * totalBalance / 2} USD)`);
    
                    const marketDatas: { [name: string]: PerpsMarketInfo } = {};
                    for (const n in allPerpsMarkets) {
                        marketDatas[n] = await allPerpsMarkets[n].readMarketData(opts.symbol, estimatedAmount);
                    }
    
                    // find the perp market with the lowest funding rate
                    const lowestFundingPerpMarket: PerpsMarketInfo = _.minBy(Object.values(marketDatas), d => d.fundingRate)!;
    
                    // find the perp market with the highest funding rate
                    const highestFundingPerpMarket: PerpsMarketInfo = _.maxBy(Object.values(marketDatas), d => d.fundingRate)!;
    
                    const fundingResult = highestFundingPerpMarket.fundingRate - lowestFundingPerpMarket.fundingRate;
    
                    const longMarket = _.findKey(marketDatas, (v) => v === lowestFundingPerpMarket)!;
                    const shortMarket = _.findKey(marketDatas, (v) => v === highestFundingPerpMarket)!;
    
                    timelog(`calculated current best funding rate: ${fundingResult * 86400 * 365 * 100}%/yr`);
                    timelog(`LONG  ${allPerpsMarkets[longMarket].name()} ${lowestFundingPerpMarket.fundingRate} ${lowestFundingPerpMarket.buyLoss}`);
                    timelog(`SHORT ${allPerpsMarkets[shortMarket].name()} ${highestFundingPerpMarket.fundingRate} ${highestFundingPerpMarket.sellLoss}`);
    
                    // discover profitability
                    const profitability = fundingResult * estimatedAmount * opts.minProfitTime - lowestFundingPerpMarket.buyLoss + highestFundingPerpMarket.sellLoss;
    
                    timelog(`calculated time period profitability ${profitability}`);
    
                    if (profitability > 0) {
                        // execute
                        await applyPosition(wallet, allPerpsMarkets[longMarket], allPerpsMarkets[shortMarket], {
                            leverage: parseFloat(opts.leverage),
                            symbol: opts.symbol,
                            rebalanceThreshold: opts.rebalanceThreshold,
                        });
    
                        currentTrade = {
                            longMarket,
                            shortMarket,
                            startBalance: totalBalance
                        }

                        fs.writeFileSync(opts.state, JSON.stringify(currentTrade));
                    }
                } else {
    
                    // verify status of trade remains profitable
                    const longMarketInfo = await allPerpsMarkets[currentTrade.longMarket].readMarketData(opts.symbol, 1);
                    const shortMarketInfo = await allPerpsMarkets[currentTrade.shortMarket].readMarketData(opts.symbol, 1);
    
                    const fundingResult = shortMarketInfo.fundingRate - longMarketInfo.fundingRate;
    
                    timelog(`calculated current trade profitability ${fundingResult * 86400 * 365 * 100}%/yr`);
    
                    if (fundingResult < 0) {
                        timelog(`existing trade is not profitable. stop`);
                        await applyPosition(wallet, allPerpsMarkets[currentTrade.longMarket], allPerpsMarkets[currentTrade.shortMarket], {
                            leverage: 1,
                            symbol: opts.symbol,
                            rebalanceThreshold: 1
                        });
    
                        // trade completed. send dev fee
                        const newBalance = await calculateTotalBalance();
                        const profit = newBalance - currentTrade.startBalance;
                        timelog(`total profitability for trade: ${profit}.`);
                        if (profit > 0) {
                            const tipAmount = profit * opts.divTip;
                            timelog(`sending dev tip of ${tipAmount} (tyvm)`);
    
                            await allPerpsMarkets[currentTrade.longMarket].withdraw(opts.devAddress, tipAmount);
                        }
    
                        currentTrade = null;
                        fs.writeFileSync(opts.state, JSON.stringify(currentTrade));
                        continue;
                    }
    
                    // verify that we don't need to rebalance. if so, call `applyTrade`
                    //const longPerpsBalance = await currentTrade.longMarket.getBalance();
                    const shortPerpsBalance = await allPerpsMarkets[currentTrade.shortMarket].getBalance([opts.symbol]);
                
                    const totalBalance = await calculateTotalBalance();
    
                    timelog(`current balance ${totalBalance}`);
                    if (Math.abs((shortPerpsBalance - totalBalance / 2) / (totalBalance / 2)) > opts.rebalanceThreshold) {
                        timelog(`rebalance required`);
                        await applyPosition(wallet, allPerpsMarkets[currentTrade.longMarket], allPerpsMarkets[currentTrade.shortMarket], {
                            leverage: parseFloat(opts.leverage),
                            symbol: opts.symbol,
                            rebalanceThreshold: 0
                        });
                    }
                }
            } catch (err) {
                console.error('uncaught error', err);
            }

            // wait
            await sleep(opts.period * 1000);
        }
    });

program.parse();

async function transferBetweenPerpsMarkets(wallet: ethers.Wallet, fromPerps: PerpsMarketAdapter, toPerps: PerpsMarketAdapter, amountMoved: number) {
    await fromPerps.withdraw(wallet.address, amountMoved);

    let amountToDeposit = amountMoved;
    const uniswapExchange = new UniswapExchange(wallet.provider!);
    if (await fromPerps.getRequiredDepositToken() != await toPerps.getRequiredDepositToken()) {
        amountToDeposit = await uniswapExchange.convert(
            wallet,
            await fromPerps.getRequiredDepositToken(), 
            await toPerps.getRequiredDepositToken(),
            amountMoved
        );
    }

    await toPerps.deposit(wallet, amountToDeposit);
}

async function applyPosition(wallet: ethers.Wallet, longPerps: PerpsMarketAdapter, shortPerps: PerpsMarketAdapter, opts: TradeOptions) {
    timelog(`apply ${wallet.address} ${longPerps.name()} -${shortPerps.name()} ${opts.symbol} ${opts.leverage}`)
    // calculate total balance of account
    const longPerpsBalance = await longPerps.getBalance([opts.symbol]);
    const shortPerpsBalance = await shortPerps.getBalance([opts.symbol]);

    const totalBalance = longPerpsBalance + shortPerpsBalance;

    // rebalance if necessary
    if (Math.abs((shortPerpsBalance - totalBalance / 2) / (totalBalance / 2)) > opts.rebalanceThreshold) {
        timelog(`rebalance required: transfer ${Math.abs(totalBalance / 2 - shortPerpsBalance)}`);
        if (shortPerpsBalance < totalBalance / 2) {
            const amountMoved = totalBalance / 2 - shortPerpsBalance;
            await transferBetweenPerpsMarkets(wallet, longPerps, shortPerps, amountMoved);
        } else {
            // move funds from bybit to synthetix
            const amountMoved = totalBalance / 2 - longPerpsBalance;
            await transferBetweenPerpsMarkets(wallet, shortPerps, longPerps, amountMoved);
        }
    }

    // the size of the position is the amount of balance we have in the lowest account divided by the token price, with a bit of margin
    //console.log('FIGURE IT OUT', opts.leverage, Math.min(await longPerps.getBalance(), await shortPerps.getBalance()), await longPerps.getPrice(opts.symbol), await shortPerps.getPrice(opts.symbol));
    const positionAmount = opts.leverage * 0.95 * Math.min(await longPerps.getBalance([opts.symbol]), await shortPerps.getBalance([opts.symbol])) / 
        Math.max(await longPerps.getPrice(opts.symbol), await shortPerps.getPrice(opts.symbol));

    // actualize trade
    timelog('set order', shortPerps.name(), -positionAmount, opts.leverage);
    await shortPerps.setOrder({
        symbol: opts.symbol,
        amount: -positionAmount,
        leverage: opts.leverage
    });

    timelog('set order', longPerps.name(), positionAmount, opts.leverage);
    await longPerps.setOrder({
        symbol: opts.symbol,
        amount: positionAmount,
        leverage: opts.leverage
    });
}