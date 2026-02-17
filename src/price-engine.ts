/**
 * Price Engine — maintains rolling candle buffer from Bybit WebSocket
 * (Binance.us WS silently drops data from this server)
 * and cross-checks via CoinGecko polling
 */

import WebSocket from "ws";
import { EventEmitter } from "events";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  final: boolean;
}

export interface PolymarketBook {
  upBestBid: number;
  upBestAsk: number;
  downBestBid: number;
  downBestAsk: number;
  upAskDepth: number;
  downAskDepth: number;
  lastUpdate: number;
}

export class PriceEngine extends EventEmitter {
  private bybitWs: WebSocket | null = null;
  private polyWs: WebSocket | null = null;
  private polySubscribedTokens: string[] = [];
  private candles: Candle[] = [];
  private maxCandles = 120; // 2 hours of 1-min candles
  public lastBinancePrice = 0; // keeping field name for compat
  public lastChainlinkPrice = 0;
  public lastPriceTime = 0;
  public connected = { binance: false, chainlink: false, polymarket: false };
  public polyBook: PolymarketBook = {
    upBestBid: 0, upBestAsk: 0, downBestBid: 0, downBestAsk: 0,
    upAskDepth: 0, downAskDepth: 0, lastUpdate: 0,
  };
  private polyTokenMap: Map<string, "UP" | "DOWN"> = new Map();
  public windowOpenPrices: Map<number, number> = new Map();

  async bootstrap() {
    // Seed with REST data from Binance.us (REST still works, just WS is dead)
    console.log("[price] Bootstrapping with Binance REST candles...");
    try {
      const res = await fetch(
        "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60"
      );
      const klines = (await res.json()) as any[];
      this.candles = klines.map((k: any) => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        final: true,
      }));
      this.lastBinancePrice = this.candles[this.candles.length - 1]?.close ?? 0;
      console.log(
        `[price] Bootstrapped ${this.candles.length} candles. Latest: $${this.lastBinancePrice}`
      );
    } catch (e: any) {
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
        this.bybitWs!.send(JSON.stringify({
          op: "subscribe",
          args: ["publicTrade.BTCUSDT", "kline.1.BTCUSDT"],
        }));
      });

      this.bybitWs.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle subscription confirmation
          if (msg.op === "subscribe") return;

          // Handle pong
          if (msg.op === "pong") return;

          if (!msg.data || !msg.topic) return;

          // Handle trade stream — real-time price ticks
          if (msg.topic === "publicTrade.BTCUSDT") {
            const trade = msg.data[msg.data.length - 1]; // latest trade
            if (!trade) return;
            const price = parseFloat(trade.p);
            this.lastBinancePrice = price;
            this.lastPriceTime = Date.now();
            
            // Update current candle with trade price
            const last = this.candles[this.candles.length - 1];
            if (last && !last.final) {
              last.close = price;
              if (price > last.high) last.high = price;
              if (price < last.low) last.low = price;
            }
            
            this.emit("tick", { source: "binance", price, time: Date.now() });
            return;
          }

          // Handle kline stream — candle structure
          if (!msg.topic.startsWith("kline.")) return;

          const k = msg.data[0];
          if (!k) return;

          const candle: Candle = {
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
            } else {
              this.candles.push(candle);
              if (this.candles.length > this.maxCandles) this.candles.shift();
            }
            this.emit("candle", candle);
          } else {
            const last = this.candles[this.candles.length - 1];
            if (last && last.time === candle.time) {
              this.candles[this.candles.length - 1] = candle;
            } else if (!last || candle.time > last.time) {
              this.candles.push(candle);
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      this.bybitWs.on("close", () => {
        console.log("[price] Bybit WS disconnected. Reconnecting in 5s...");
        this.connected.binance = false;
        setTimeout(connect, 5000);
      });

      this.bybitWs.on("error", (err: Error) => {
        console.error("[price] Bybit WS error:", err.message);
      });

      // Bybit requires ping every 20s to keep connection alive
      const pingInterval = setInterval(() => {
        if (this.bybitWs?.readyState === WebSocket.OPEN) {
          this.bybitWs.send(JSON.stringify({ op: "ping" }));
        } else {
          clearInterval(pingInterval);
        }
      }, 20_000);
    };

    connect();
  }

  /**
   * Polymarket CLOB WebSocket — real-time orderbook updates for current market
   * Public channel, no auth needed, not geo-blocked
   */
  connectPolymarket() {
    const url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    console.log("[price] Connecting to Polymarket CLOB WebSocket...");

    const connect = () => {
      this.polyWs = new WebSocket(url);

      this.polyWs.on("open", () => {
        console.log("[price] Polymarket WS connected");
        this.connected.polymarket = true;
        // Re-subscribe if we had tokens
        if (this.polySubscribedTokens.length > 0) {
          this.polyWs!.send(JSON.stringify({
            type: "market",
            assets_ids: this.polySubscribedTokens,
          }));
          console.log(`[price] Re-subscribed to ${this.polySubscribedTokens.length} tokens`);
        }
      });

      this.polyWs.on("message", (data: Buffer) => {
        try {
          const msgs = JSON.parse(data.toString());
          // Can be a single message or array
          const msgArr = Array.isArray(msgs) ? msgs : [msgs];
          
          for (const msg of msgArr) {
            if (msg.event_type === "price_change" && msg.price_changes) {
              for (const pc of msg.price_changes) {
                const direction = this.polyTokenMap.get(pc.asset_id);
                if (!direction) continue;
                
                const bestBid = parseFloat(pc.best_bid || "0");
                const bestAsk = parseFloat(pc.best_ask || "0");
                
                if (direction === "UP") {
                  if (bestBid > 0) this.polyBook.upBestBid = bestBid;
                  if (bestAsk > 0) this.polyBook.upBestAsk = bestAsk;
                } else {
                  if (bestBid > 0) this.polyBook.downBestBid = bestBid;
                  if (bestAsk > 0) this.polyBook.downBestAsk = bestAsk;
                }
                this.polyBook.lastUpdate = Date.now();
              }
              this.emit("polybook", this.polyBook);
            } else if (msg.event_type === "book") {
              const direction = this.polyTokenMap.get(msg.asset_id);
              if (!direction) continue;
              
              const asks = msg.asks || [];
              if (asks.length > 0) {
                // Best ask = lowest price
                const sorted = asks.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                  .sort((a: any, b: any) => a.price - b.price);
                if (direction === "UP") {
                  this.polyBook.upBestAsk = sorted[0].price;
                  this.polyBook.upAskDepth = sorted[0].size;
                } else {
                  this.polyBook.downBestAsk = sorted[0].price;
                  this.polyBook.downAskDepth = sorted[0].size;
                }
              }
              const bids = msg.bids || [];
              if (bids.length > 0) {
                const bestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
                if (direction === "UP") this.polyBook.upBestBid = bestBid;
                else this.polyBook.downBestBid = bestBid;
              }
              this.polyBook.lastUpdate = Date.now();
              this.emit("polybook", this.polyBook);
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      this.polyWs.on("close", () => {
        console.log("[price] Polymarket WS disconnected. Reconnecting in 3s...");
        this.connected.polymarket = false;
        setTimeout(connect, 3000);
      });

      this.polyWs.on("error", (err: Error) => {
        console.error("[price] Polymarket WS error:", err.message);
      });
    };

    connect();
  }

  /**
   * Subscribe to a new market's tokens for real-time orderbook updates
   */
  subscribeMarket(upTokenId: string, downTokenId: string) {
    this.polyTokenMap.set(upTokenId, "UP");
    this.polyTokenMap.set(downTokenId, "DOWN");
    this.polySubscribedTokens = [upTokenId, downTokenId];
    
    // Reset book state for new market
    this.polyBook = {
      upBestBid: 0, upBestAsk: 0, downBestBid: 0, downBestAsk: 0,
      upAskDepth: 0, downAskDepth: 0, lastUpdate: 0,
    };

    if (this.polyWs?.readyState === WebSocket.OPEN) {
      this.polyWs.send(JSON.stringify({
        type: "market",
        assets_ids: [upTokenId, downTokenId],
      }));
      console.log(`[price] Subscribed to Polymarket market tokens`);
    }
  }

  /**
   * CoinGecko polling as cross-check (every 30s)
   */
  private cgInterval: ReturnType<typeof setInterval> | null = null;

  startCoinGeckoPolling() {
    console.log("[price] Starting CoinGecko cross-check (every 30s)...");
    this.connected.chainlink = true;

    const poll = async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&precision=2"
        );
        const data = (await res.json()) as any;
        const price = data?.bitcoin?.usd;
        if (price && price > 0) {
          this.lastChainlinkPrice = price;
          this.emit("tick", { source: "coingecko", price, time: Date.now() });
        }
      } catch (e) {
        // silent
      }
    };

    poll();
    this.cgInterval = setInterval(poll, 30_000);
  }

  getCloses(): number[] {
    return this.candles.filter((c) => c.final).map((c) => c.close);
  }

  getAllCloses(): number[] {
    return this.candles.map((c) => c.close);
  }

  getPriceDivergence(): { diff: number; pct: number } {
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
    this.polyWs?.close();
    this.polyWs = null;
    if (this.cgInterval) clearInterval(this.cgInterval);
  }
}
