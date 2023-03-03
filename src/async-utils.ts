import { ethers } from "ethers";

export function timelog(...args: any) {
	console.log(new Date().toISOString(), '\t', ...args);
}

export async function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
};

export async function condition(call: () => Promise<number>, pollInterval: number = 5000, minVal = 1e-9) {
	let amount = await call();
	while(amount < minVal) {
		await sleep(pollInterval || 500);
		amount = await call();
		timelog('poll', amount.toString());
	}

	return amount;
}

export async function retryOp(name: string, call: () => Promise<any>, tries = 3) {
	let attempts = 0;
	timelog('exec:', name);
	while(true) {
		try {
			const obj = await call();

			if(obj.wait) {
				const r = await obj.wait();
				if (!r.status) {
					throw new Error('txn failed');
				}

				return r;
			}
			else {
				return obj;
			}
			
		} catch(err) {
			timelog(`operation ${name} failed:`, err);

			if (attempts > tries) {
				timelog('too many errors, exiting');
				process.exit(1);
			}

			timelog(`${tries} remain`);
			await sleep(10000 * Math.pow(2, attempts++));
		}
	}
}