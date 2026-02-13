/**
 * Price Engine — maintains rolling candle buffer from Binance WebSocket
 * and tracks Chainlink prices from Polymarket real-time data
 */
import WebSocket from "ws";
import { EventEmitter } from "events";
export class PriceEngine extends EventEmitter {
    binanceWs = null;
    chainlinkWs = null;
    candles = [];
    maxCandles = 120; // 2 hours of 1-min candles
    lastBinancePrice = 0;
    lastChainlinkPrice = 0;
    lastPriceTime = 0;
    connected = { binance: false, chainlink: false };
    async bootstrap() {
        // Seed with REST data first
        console.log("[price] Bootstrapping with Binance REST candles...");
        const res = await fetch("https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60");
        const klines = (await res.json());
        this.candles = klines.map((k) => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            final: true,
        }));
        this.lastBinancePrice = this.candles[this.candles.length - 1]?.close ?? 0;
        console.log(`[price] Bootstrapped ${this.candles.length} candles. Latest: $${this.lastBinancePrice}`);
    }
    connectBinance() {
        const url = "wss://stream.binance.us:9443/ws/btcusdt@kline_1m";
        console.log("[price] Connecting to Binance WebSocket...");
        const connect = () => {
            this.binanceWs = new WebSocket(url);
            this.binanceWs.on("open", () => {
                console.log("[price] Binance WS connected");
                this.connected.binance = true;
                this.emit("binance:connected");
            });
            this.binanceWs.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.e !== "kline")
                        return;
                    const k = msg.k;
                    const candle = {
                        time: k.t,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v),
                        final: k.x,
                    };
                    this.lastBinancePrice = candle.close;
                    this.lastPriceTime = Date.now();
                    if (candle.final) {
                        // New completed candle
                        const existing = this.candles.findIndex((c) => c.time === candle.time);
                        if (existing >= 0) {
                            this.candles[existing] = candle;
                        }
                        else {
                            this.candles.push(candle);
                            if (this.candles.length > this.maxCandles)
                                this.candles.shift();
                        }
                        this.emit("candle", candle);
                    }
                    else {
                        // Update current candle
                        const last = this.candles[this.candles.length - 1];
                        if (last && last.time === candle.time) {
                            this.candles[this.candles.length - 1] = candle;
                        }
                        else if (!last || candle.time > last.time) {
                            this.candles.push(candle);
                        }
                    }
                    this.emit("tick", { source: "binance", price: candle.close, time: Date.now() });
                }
                catch (e) {
                    // ignore parse errors
                }
            });
            this.binanceWs.on("close", () => {
                console.log("[price] Binance WS disconnected. Reconnecting in 5s...");
                this.connected.binance = false;
                setTimeout(connect, 5000);
            });
            this.binanceWs.on("error", (err) => {
                console.error("[price] Binance WS error:", err.message);
            });
        };
        connect();
    }
    /**
     * CoinGecko polling as cross-check (every 30s)
     * Polymarket Chainlink WS is geo-restricted from this server
     */
    cgInterval = null;
    startCoinGeckoPolling() {
        console.log("[price] Starting CoinGecko cross-check (every 30s)...");
        this.connected.chainlink = true; // repurpose as "cross-check active"
        const poll = async () => {
            try {
                const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&precision=2");
                const data = (await res.json());
                const price = data?.bitcoin?.usd;
                if (price && price > 0) {
                    this.lastChainlinkPrice = price; // use CoinGecko as cross-check price
                    this.emit("tick", { source: "coingecko", price, time: Date.now() });
                }
            }
            catch (e) {
                // silent
            }
        };
        poll();
        this.cgInterval = setInterval(poll, 30_000);
    }
    getCloses() {
        return this.candles.filter((c) => c.final).map((c) => c.close);
    }
    getAllCloses() {
        // Include the current incomplete candle
        return this.candles.map((c) => c.close);
    }
    getPriceDivergence() {
        if (!this.lastBinancePrice || !this.lastChainlinkPrice) {
            return { diff: 0, pct: 0 };
        }
        const diff = Math.abs(this.lastBinancePrice - this.lastChainlinkPrice);
        const pct = (diff / this.lastBinancePrice) * 100;
        return { diff, pct };
    }
    stop() {
        this.binanceWs?.close();
        this.binanceWs = null;
        if (this.cgInterval)
            clearInterval(this.cgInterval);
    }
}
