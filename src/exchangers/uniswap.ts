import { retryOp, timelog } from "../async-utils";
import { ethers } from "ethers";


import ERC20_ABI from '../abi/ERC20.json';
import UNISWAP_QUOTER_ABI from '../abi/UniswapQuoter.json';
import UNISWAP_ROUTER_ABI from '../abi/UniswapRouter.json';

import addresses from '../addresses.json';

export default class UniswapExchange {

    provider: ethers.Provider;

    constructor(provider: ethers.Provider) {
        this.provider = provider;
    }

    async quote(src: string, dst: string, amount: number): Promise<number> {
        const contract = new ethers.Contract(addresses.optimism.exchanges.UniswapQuoter, UNISWAP_QUOTER_ABI);

        const srcTokenContract = new ethers.Contract(src, ERC20_ABI);
        const dstTokenContract = new ethers.Contract(dst, ERC20_ABI);

        return parseFloat(ethers.formatUnits((await contract.quoteExactInput(
            [src, 500, dst],
            ethers.parseUnits(amount.toString(), await srcTokenContract.decimals()),
        )), await dstTokenContract.decimals()));
    }

    async convert(wallet: ethers.Wallet, src: string, dst: string, amount: number): Promise<number> {
        const contract = new ethers.Contract(addresses.optimism.exchanges.UniswapRouter, UNISWAP_ROUTER_ABI, wallet);

        const srcTokenContract = new ethers.Contract(src, ERC20_ABI, wallet);
        const dstTokenContract = new ethers.Contract(dst, ERC20_ABI, wallet);

        timelog('exchange uniswap', await srcTokenContract.symbol(), await dstTokenContract.symbol(), amount);

        if (await srcTokenContract.allowance(wallet.address, contract.getAddress()) == 0) {
            await retryOp('approve uniswap', async () => srcTokenContract.approve(contract.getAddress(), ethers.MaxUint256));
        }

        const receipt: ethers.TransactionReceipt = await retryOp('uniswap', async () => contract.exactInput({
            path: ethers.solidityPacked(
                ['address', 'uint24', 'address'],
                [src, 500, dst]
            ),
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 300,
            amountIn: ethers.parseUnits(amount.toString(), await srcTokenContract.decimals()),
            amountOutMinimum: ethers.parseUnits((amount * 0.99).toString(), await dstTokenContract.decimals()),
        }));

        timelog('complete', receipt.hash);

        return parseFloat(ethers.formatUnits(await dstTokenContract.balanceOf(wallet.address), await dstTokenContract.decimals()));
    }
}