/**
 * Price Engine — maintains rolling candle buffer from Bybit WebSocket
 * (Binance.us WS silently drops data from this server)
 * and cross-checks via CoinGecko polling
 */
import WebSocket from "ws";
import { EventEmitter } from "events";
export class PriceEngine extends EventEmitter {
    bybitWs = null;
    candles = [];
    maxCandles = 120; // 2 hours of 1-min candles
    lastBinancePrice = 0; // keeping field name for compat
    lastChainlinkPrice = 0;
    lastPriceTime = 0;
    connected = { binance: false, chainlink: false };
    async bootstrap() {
        // Seed with REST data from Binance.us (REST still works, just WS is dead)
        console.log("[price] Bootstrapping with Binance REST candles...");
        try {
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
        catch (e) {
            console.error(`[price] Bootstrap failed: ${e.message}. Starting with empty candles.`);
        }
    }
    connectBinance() {
        // Using Bybit spot WebSocket — Binance.us WS connects but sends no data
        const url = "wss://stream.bybit.com/v5/public/spot";
        console.log("[price] Connecting to Bybit WebSocket...");
        const connect = () => {
            this.bybitWs = new WebSocket(url);
            this.bybitWs.on("open", () => {
                console.log("[price] Bybit WS connected");
                this.connected.binance = true;
                this.emit("binance:connected");
                // Subscribe to both trades (real-time ticks) and 1-min kline (candle structure)
                this.bybitWs.send(JSON.stringify({
                    op: "subscribe",
                    args: ["publicTrade.BTCUSDT", "kline.1.BTCUSDT"],
                }));
            });
            this.bybitWs.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    // Handle subscription confirmation
                    if (msg.op === "subscribe")
                        return;
                    // Handle pong
                    if (msg.op === "pong")
                        return;
                    if (!msg.data || !msg.topic)
                        return;
                    // Handle trade stream — real-time price ticks
                    if (msg.topic === "publicTrade.BTCUSDT") {
                        const trade = msg.data[msg.data.length - 1]; // latest trade
                        if (!trade)
                            return;
                        const price = parseFloat(trade.p);
                        this.lastBinancePrice = price;
                        this.lastPriceTime = Date.now();
                        // Update current candle with trade price
                        const last = this.candles[this.candles.length - 1];
                        if (last && !last.final) {
                            last.close = price;
                            if (price > last.high)
                                last.high = price;
                            if (price < last.low)
                                last.low = price;
                        }
                        this.emit("tick", { source: "binance", price, time: Date.now() });
                        return;
                    }
                    // Handle kline stream — candle structure
                    if (!msg.topic.startsWith("kline."))
                        return;
                    const k = msg.data[0];
                    if (!k)
                        return;
                    const candle = {
                        time: parseInt(k.start),
                        open: parseFloat(k.open),
                        high: parseFloat(k.high),
                        low: parseFloat(k.low),
                        close: parseFloat(k.close),
                        volume: parseFloat(k.volume),
                        final: k.confirm === true,
                    };
                    this.lastBinancePrice = candle.close;
                    this.lastPriceTime = Date.now();
                    if (candle.final) {
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
                        const last = this.candles[this.candles.length - 1];
                        if (last && last.time === candle.time) {
                            this.candles[this.candles.length - 1] = candle;
                        }
                        else if (!last || candle.time > last.time) {
                            this.candles.push(candle);
                        }
                    }
                }
                catch (e) {
                    // ignore parse errors
                }
            });
            this.bybitWs.on("close", () => {
                console.log("[price] Bybit WS disconnected. Reconnecting in 5s...");
                this.connected.binance = false;
                setTimeout(connect, 5000);
            });
            this.bybitWs.on("error", (err) => {
                console.error("[price] Bybit WS error:", err.message);
            });
            // Bybit requires ping every 20s to keep connection alive
            const pingInterval = setInterval(() => {
                if (this.bybitWs?.readyState === WebSocket.OPEN) {
                    this.bybitWs.send(JSON.stringify({ op: "ping" }));
                }
                else {
                    clearInterval(pingInterval);
                }
            }, 20_000);
        };
        connect();
    }
    /**
     * CoinGecko polling as cross-check (every 30s)
     */
    cgInterval = null;
    startCoinGeckoPolling() {
        console.log("[price] Starting CoinGecko cross-check (every 30s)...");
        this.connected.chainlink = true;
        const poll = async () => {
            try {
                const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&precision=2");
                const data = (await res.json());
                const price = data?.bitcoin?.usd;
                if (price && price > 0) {
                    this.lastChainlinkPrice = price;
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
        this.bybitWs?.close();
        this.bybitWs = null;
        if (this.cgInterval)
            clearInterval(this.cgInterval);
    }
}
