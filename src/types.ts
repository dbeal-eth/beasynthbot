import { ethers } from "ethers";

export interface PerpsMarketAdapter {

    name: () => string;

    readMarketData: (symbol: string, amount: number) => Promise<PerpsMarketInfo>;
    setOrder: (order: PerpsOrder) => Promise<void>;
    
    getBalance: (symbols: string[]) => Promise<number>;
    getMaxProfitableSize: (symbol: string, leverage: number) => Promise<number>;
    getRequiredDepositToken: () => Promise<string>;
    getPrice: (symbol: string) => Promise<number>;
    deposit: (wallet: ethers.Wallet, amount: number) => Promise<void>;
    withdraw: (address: string, amount: number) => Promise<void>;
}

export interface ExchangeAdapter {
    convert: (wallet: ethers.Wallet, src: string, dst: string, amount: number) => Promise<number>;
}

export type PerpsOrder = {
    symbol: string;
    amount: number;
    leverage: number;
}

export type PerpsMarketInfo = {
    buyLoss: number;
    sellLoss: number;
    fundingRate: number; // positive rate = buyer pays, negative rate = seller pays
}

export type TradeOptions = {
    symbol: string,
    rebalanceThreshold: number,
    leverage: number,
}