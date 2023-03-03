import crypto from 'crypto';
import querystring from 'querystring';
import axios from "axios";
import { ethers } from 'ethers';
import { PerpsMarketAdapter, PerpsMarketInfo, PerpsOrder } from "../types";

import addresses from '../addresses.json';
import { getTokenContract } from '../contracts';
import { condition, retryOp, timelog } from '../async-utils';

const API = 'https://api.bybit.com';

export default class BybitPerpMarket implements PerpsMarketAdapter {
    private provider: ethers.Provider;
    private apiKey: string;
    private apiSecret: string;
    private baseToken: string;
    private apiUrl: string;

    constructor(
        provider: ethers.Provider,
        apiKey: string, 
        apiSecret: string,
        baseToken: string = 'USDT',
        apiUrl: string = API
    ) {
        this.provider = provider;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseToken = baseToken;
        this.apiUrl = apiUrl;
    }

    name() {
        return 'BYBIT';
    }

    getSignature(parameters: string, secret: string, timestamp: string) {
        return crypto.createHmac('sha256', secret).update(timestamp + this.apiKey + '5000' + parameters).digest('hex');
    }

    async makeRequest(endpoint: string, method: string, data: any) {
        const formattedData = method === 'POST' ? JSON.stringify(data) : querystring.encode(data);

        const timestamp = Date.now().toString();
        const sign = this.getSignature(formattedData, this.apiSecret, timestamp);

        const fullEndpoint = this.apiUrl + endpoint + (method !== 'POST' ? '?' + formattedData : '');

        var config = {
            method: method,
            url: fullEndpoint,
            headers: { 
                'X-BAPI-SIGN-TYPE': '2', 
                'X-BAPI-SIGN': sign, 
                'X-BAPI-API-KEY': this.apiKey, 
                'X-BAPI-TIMESTAMP': timestamp, 
                'X-BAPI-RECV-WINDOW': '5000', 
                'Content-Type': 'application/json; charset=utf-8'
            },
            data: method === 'POST' ? data : undefined
        };

        const res = await retryOp(`bybit ${endpoint}`, () => axios(config));

        if (res.data.retCode !== 0) {
            throw new Error('request failed:', res.data.retMsg);
        }

        return res;
    }

    private async getCurrentOrder(symbol: string): Promise<[PerpsOrder, any]> {
        const positionRes = await this.makeRequest('/v5/position/list', 'GET', {category: 'linear', symbol: `${symbol}${this.baseToken}`});

        return [{
            symbol,
            amount: positionRes.data.result.list[0].size,
            leverage: positionRes.data.result.list[0].leverage,
        }, positionRes.data.result.list[0]]
    }

    private async quote(symbol: string, amount: number) {
        const orderbook = await this.makeRequest('/v5/market/orderbook', 'GET', {category: 'linear', limit: '200', symbol: `${symbol}${this.baseToken}`});

        const midMarketPrice = (parseFloat(orderbook.data.result.a[0][0]) + parseFloat(orderbook.data.result.b[0][0])) / 2;

        
        // buybit charges 0.1% fee for any order
        let buyLoss = amount * 0.001;
        let sellLoss = amount * 0.001;

        let remainingAmount = amount;
        for (const buy of orderbook.data.result.a) {
            if (buy[1] < remainingAmount) {
                buyLoss += (parseFloat(buy[0]) - midMarketPrice) * parseFloat(buy[1]);
                remainingAmount -= parseFloat(buy[1]);
            }
            else {
                buyLoss += (parseFloat(buy[0]) - midMarketPrice) * remainingAmount;
                break;
            }
        }

        remainingAmount = amount;
        for (const sell of orderbook.data.result.b) {
            if (sell[1] < remainingAmount) {
                sellLoss += (midMarketPrice - parseFloat(sell[0])) * parseFloat(sell[1]);
                remainingAmount -= parseFloat(sell[1]);
            }
            else {
                sellLoss += (midMarketPrice - parseFloat(sell[0])) * remainingAmount;
                break;
            }
        }

        return [buyLoss, sellLoss];
    }

    async readMarketData(symbol: string, amount: number): Promise<PerpsMarketInfo> {
        const [buyLoss, sellLoss] = await this.quote(symbol, amount);
        const marketInfo: PerpsMarketInfo = {
            buyLoss,
            sellLoss,
            fundingRate: parseFloat(
                (await this.makeRequest('/v5/market/funding/history', 'GET', {category: 'linear', symbol: 'ETHPERP', limit: '1'}))
                    .data.result.list[0].fundingRate
            ) / (8 * 3600) // bybit uses 8 hours for its funding time, and we want funding rate in seconds
        }

        return marketInfo;
    }
    
    async setOrder(order: PerpsOrder) {
        // get current order
        const [currentOrder, fullOrderInfo] = await this.getCurrentOrder(order.symbol);

        const deltaAmt = order.amount - currentOrder.amount;

        if (Math.abs(deltaAmt) < 0.01 && Math.abs(currentOrder.leverage - order.leverage) < 0.01) {
            return;
        }

        // adjust leverage if necessary
        if (
            !currentOrder || 
            currentOrder.leverage != order.leverage ||
            fullOrderInfo.tradeMode != 0 
        ) {
            await this.makeRequest('/v5/position/set-leverage', 'POST', {
                category: 'linear',
                symbol: order.symbol + this.baseToken,
                buyLeverage: order.leverage.toString(),
                sellLeverage: order.leverage.toString(),
            });
        }

        // create order to adjust position (if necessary)
        if (deltaAmt != 0) {
            await this.makeRequest('/v5/order/create', 'POST', {
                "category": "linear",
                "symbol": order.symbol + this.baseToken,
                "side": deltaAmt > 0 ? "Buy" : "Sell",
                "orderType": "Market",
                "qty": Math.abs(deltaAmt).toString().slice(0,8),
            });
        }

        await condition(
            async () => {
                const possibleNewOrder = (await this.getCurrentOrder(order.symbol))[0];
                return Math.abs(possibleNewOrder.amount - currentOrder.amount) + 
                    Math.abs(possibleNewOrder.leverage - currentOrder.leverage) 
            },
            5000,
            0.01
        );
    }

    async getPrice(symbol: string) {
        const orderbook = await this.makeRequest('/v5/market/orderbook', 'GET', {category: 'linear', limit: '1', symbol: `${symbol}${this.baseToken}`});
        return (parseFloat(orderbook.data.result.a[0][0]) + parseFloat(orderbook.data.result.b[0][0])) / 2;
    }

    async getBalance(): Promise<number> {
        const balanceResult = await this.makeRequest(`/v5/asset/transfer/query-account-coin-balance`, 'GET', {
            coin: this.baseToken,
            accountType: 'CONTRACT'
        });

        return parseFloat(balanceResult.data.result.balance.walletBalance);
    }

    async getMaxProfitableSize(symbol: string, leverage: number): Promise<number> {
        return leverage * 0.95 * await this.getBalance() / await this.getPrice(symbol);
    }

    async getRequiredDepositToken(): Promise<string> {
        return addresses.optimism.tokens.USDT;
    }

    async deposit(wallet: ethers.Wallet, amount: number) {
        const depositAddrRes = await this.makeRequest('/v5/asset/deposit/query-address', 'GET', {coin: this.baseToken, chainType: 'OP'});

        const depositAddr = depositAddrRes.data.result.chains[0].addressDeposit;

        const tokenContract = getTokenContract('USDT', wallet);

        const prevBalance = await this.getBalance();

        timelog('bybit reported deposit address', depositAddr);

        await retryOp('deposit bybit', 
            async () => tokenContract.transfer(depositAddr, ethers.parseUnits(amount.toString(), await tokenContract.decimals()))
        );

        // wait for our available balance to go up
        await condition(
            async () => await this.getBalance() - prevBalance,
        );
    }

    async withdraw(address: string, amount: number) {
        console.log('sending params', {
            transferId: crypto.randomUUID(),
            coin: this.baseToken,
            amount: amount.toString(),
            fromAccountType: 'CONTRACT',
            toAccountType: 'FUND'
        });

        const interTransferResult = await this.makeRequest(`/v5/asset/transfer/inter-transfer`, 'POST', {
            transferId: crypto.randomUUID(),
            coin: this.baseToken,
            amount: amount.toString(),
            fromAccountType: 'CONTRACT',
            toAccountType: 'FUND'
        });

        timelog('inter transfer result', interTransferResult.data);

        const withdrawResult = await this.makeRequest(`/v5/asset/withdraw/create`, 'POST', {
            coin: this.baseToken,
            chain: 'OP',
            address,
            amount,
            timestamp: Date.now(),
            accountType: 'FUND'
        });

        timelog('withdraw result', withdrawResult.data);


        const tokenContract = getTokenContract('USDT', this.provider);
        await condition(() => tokenContract.balanceOf(address));
    }
}