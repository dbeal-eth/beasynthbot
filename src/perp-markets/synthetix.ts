import { ethers } from 'ethers';
import { PerpsMarketAdapter, PerpsMarketInfo, PerpsOrder } from "../types";

import addresses from '../addresses.json';

import PERPS_MANAGER_ABI from '../abi/SynthetixPerpManager.json';
import PERPS_ABI from '../abi/SynthetixPerp.json';
import { getTokenContract } from '../contracts';
import { condition, retryOp, timelog } from '../async-utils';

export const PERPS_MANAGER_ADDRESS = '0xdb89f3fc45A707Dd49781495f77f8ae69bF5cA6e';

export default class SynthetixPerpsMarket implements PerpsMarketAdapter {

    wallet: ethers.Wallet;

    maxPriceImpact: number;

    desiredTime: number;

    constructor(
        wallet: ethers.Wallet,
    ) {
        this.wallet = wallet;

        this.maxPriceImpact = 0.01;
        this.desiredTime = 300; // 5 mins
    }

    name() {
        return 'SYNTHETIX';
    }

    async getContractForSymbol(symbol: string) {
        const managerContract = new ethers.Contract(PERPS_MANAGER_ADDRESS, PERPS_MANAGER_ABI, this.wallet);
        
        const symbolAddress = await managerContract.marketForKey(ethers.encodeBytes32String(`s${symbol}PERP`));

        return new ethers.Contract(symbolAddress, PERPS_ABI, this.wallet);
    }

    async readMarketData(symbol: string, amount: number): Promise<PerpsMarketInfo> {
        const contract = await this.getContractForSymbol(symbol);

        const marketInfo: PerpsMarketInfo = {
            buyLoss: parseFloat(ethers.formatEther((await contract.orderFee(ethers.parseEther(amount.toString()), 1))[0])),
            sellLoss: parseFloat(ethers.formatEther((await contract.orderFee(ethers.parseEther((-amount).toString()), 1))[0])),
            fundingRate: parseFloat(ethers.formatEther(await contract.currentFundingRate())) / 86400
        }

        return marketInfo;
    }
    
    async setOrder(order: PerpsOrder) {
        const contract = await this.getContractForSymbol(order.symbol);

        // get current order
        const me = this.wallet.address;

        const currentSize = parseFloat(ethers.formatEther((await contract.positions(me)).size));
        const deltaAmt = order.amount - currentSize;
        const targetMargin = (Math.abs(order.amount) * parseFloat(ethers.formatEther((await contract.assetPrice())[0])) / order.leverage);
        const deltaMargin = targetMargin - parseFloat(ethers.formatEther((await contract.remainingMargin(me))[0]));

        timelog(`synthetix: deltaAmt ${deltaAmt}, deltaMargin ${deltaMargin}`);

        if (deltaMargin > 0) {
            // we need to deposit before submitting delayed order
            await this.transferMargin(contract, deltaMargin);

            if (deltaAmt != 0) {
                await this.submitDelayedOrder(contract, deltaAmt, currentSize);
            }

        } else {
            // we need to shrink the order before deltaing the margin
            if (deltaAmt != 0) {
                await this.submitDelayedOrder(contract, deltaAmt, currentSize);
            }

            await this.transferMargin(contract, deltaMargin);
        }
    }

    async submitDelayedOrder(contract: ethers.Contract, deltaAmt: number, currentSize: number) {
        await retryOp('submitDelayedOrder', async () => contract.submitDelayedOrder(
            ethers.parseEther(deltaAmt.toString()),
            ethers.parseEther(this.maxPriceImpact.toString()),
            BigInt(this.desiredTime.toString()),
            { gasLimit: 1000000 }
        ));

        // wait for the delayed order to be confirmed
        await condition(
            async () => {
                return Math.abs(parseFloat(ethers.formatEther((await contract.positions(this.wallet.address)).size)) - currentSize)
            }
        );
    }

    async transferMargin(contract: ethers.Contract, deltaMargin: number) {
        await retryOp('transferMargin', () => contract.transferMargin(
            ethers.parseEther(deltaMargin.toString()),
            { gasLimit: 500000 }
        ));
    }

    async getBalance(): Promise<number> {
        const contract = await this.getContractForSymbol('DYDX');
        const tokenContract = getTokenContract('sUSD', this.wallet);
        return parseFloat(ethers.formatEther((await contract.remainingMargin(this.wallet.address))[0])) +
            parseFloat(ethers.formatEther(await tokenContract.balanceOf(this.wallet.address)));
    }

    async getMaxProfitableSize(symbol: string, leverage: number): Promise<number> {
        return leverage * 0.95 * await this.getBalance() / await this.getPrice(symbol);
    }

    async getPrice(symbol: string) {
        const contract = await this.getContractForSymbol(symbol);
        return parseFloat(ethers.formatEther((await contract.fillPrice(ethers.parseEther('1')))[0]));
    }

    async getRequiredDepositToken(): Promise<string> {
        return addresses.optimism.tokens.sUSD;
    }

    async deposit(wallet: ethers.Wallet, amount: number) {
        if (wallet.address === this.wallet.address) {
            return;
        }

        const tokenContract = getTokenContract('sUSD', wallet);
        await tokenContract.transfer(this.wallet.address, ethers.parseUnits(amount.toString(), await tokenContract.decimals()));
    }

    async withdraw(address: string, amount: number) {
        if (this.wallet.address === address) {
            return;
        }

        const tokenContract = getTokenContract('sUSD', this.wallet);
        await tokenContract.transfer(address, ethers.parseUnits(amount.toString(), await tokenContract.decimals()));
    }
}