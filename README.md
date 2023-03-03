BeASynthBot
====

A trading bot for arbitraging perpetual futures--primarily with Synthetix Perps V2.

BeASynthBot will:
* calculate expected profit over time from funding rate difference
* calculate loss from executing trades
* places profitable orders if profit is greater than loss for a minimum configurable time period
* checks position to verify it remains profitable, and rebalances if necessary
* closes position when it becomes unprofitable

NOTE: This program includes sends a small tip to the author. Only the profits from profitable trades are sent. 
If you want to change this tip, you can supply additional command line arguments.

## Usage



### Requirements

You need:
* Bybit Account
* Some sUSD in Optimism, or USDT in Bybit
* Static IP address (required for withdrawals on Bybit) 
* Node.js & NPM installed on your computer

### Steps

```
npm install
npm run build
```

Then, copy `trade.sh.sample` to `trade.sh`

Edit `trade.sh` to as appropriate for your settings.

Run:

```
./trade.sh ETH 5
```

The first argument is the token you want to trade, the second argument is the leverage.

## License

Copyright (C) 2023  Daniel Beal

This program is distributed under the terms of the GNU GPLv3 license. See `LICENSE` file for more information.

This program comes with ABSOLUTELY NO WARRANTY.





