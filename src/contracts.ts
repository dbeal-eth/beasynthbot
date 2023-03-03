import { ethers } from 'ethers';
import { ContractRunner } from 'ethers/types/providers';
import ERC20ABI from './abi/ERC20.json';
import addresses from './addresses.json';

export function getTokenContract(name: keyof typeof addresses.optimism.tokens, runner?: ContractRunner) {
    return new ethers.Contract(addresses.optimism.tokens[name], ERC20ABI, runner);
}