import { Injectable, Logger } from '@nestjs/common';
import {
  BrokerAdapter,
  FeedCallback,
  OrderRequest,
  OrderResponse,
  PositionData,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { AngelOneAuthService } from './angel-one-auth.service';
import { AngelOneWebSocketService, WsFeedMode, ExchangeType } from './angel-one-websocket.service';
import { COMMODITIES, INDICES } from '@td/shared/constants';
import { MarketDepth, MarketDepthLevel } from '@td/shared/types';

/**
 * Tokens that live on BSE (not NSE). SENSEX and other BSE-listed indices
 * must be subscribed with ExchangeType.BSE_CM or Angel One drops them silently.
 * Built once from the INDICES constant.
 */
const BSE_TOKENS: ReadonlySet<string> = new Set(
  (Object.values(INDICES) as Array<{ token: string; exchange: string }>)
    .filter((idx) => idx.exchange === 'BSE')
    .map((idx) => idx.token),
);

/**
 * Map our generic order types to Angel One SmartAPI order type strings.
 */
const ORDER_TYPE_MAP: Record<string, string> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOPLOSS: 'STOPLOSS_LIMIT',
  STOPLOSS_MARKET: 'STOPLOSS_MARKET',
};

/**
 * Map our generic position types to Angel One product types.
 */
const PRODUCT_TYPE_MAP: Record<string, string> = {
  INTRADAY: 'INTRADAY',
  DELIVERY: 'DELIVERY',
  CARRYFORWARD: 'CARRYFORWARD',
};

/**
 * Map our timeframe strings to Angel One candle interval strings.
 */
const TIMEFRAME_MAP: Record<string, string> = {
  '1m': 'ONE_MINUTE',
  '3m': 'THREE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '10m': 'TEN_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

/**
 * Per-interval maximum date range Angel One's getCandleData accepts in a
 * single call. Wider windows return HTTP 200 with an EMPTY data array
 * (silent truncation — no error) which is a real footgun for backfills.
 *
 * Numbers per Angel One SmartAPI Historical API docs (Apr 2026 revision).
 * Conservative — Angel sometimes lowers these without notice; the
 * `getHistoricalData` wrapper auto-chunks any wider range so callers
 * don't have to know these limits.
 */
const TIMEFRAME_MAX_RANGE_DAYS: Record<string, number> = {
  // Empirically: for STOCK tokens (not indices), Angel One silently returns
  // empty data when the range crosses a trading-session boundary for any
  // sub-hour interval. The documented per-interval caps (e.g. 180d for 15m)
  // hold only for index tokens. Cap all sub-hour intervals to 1 day so the
  // chunking wrapper stitches per-day windows. Hour+ intervals appear
  // unaffected and keep their wider caps.
  ONE_MINUTE: 1,
  THREE_MINUTE: 1,
  FIVE_MINUTE: 1,
  TEN_MINUTE: 1,
  FIFTEEN_MINUTE: 1,
  THIRTY_MINUTE: 1,
  ONE_HOUR: 365,
  ONE_DAY: 1800,
};

/** Pacing between chunked historical calls — Angel One historical limit is 3 req/sec; 350ms keeps us under. */
const HISTORICAL_CHUNK_PACE_MS = 350;

/** Minimum gap between ANY two historical calls (across all callers). 3 req/sec hard cap → 350ms. */
const HISTORICAL_MIN_GAP_MS = 350;

/**
 * Per-timeframe TTL for the in-memory historical-candle cache (see
 * `historicalCache`). Sized so that within one re-scoring pass of ~100
 * watch entries, shared tokens (NIFTY, sector indices) and recently-
 * fetched stocks serve from cache instead of issuing fresh broker calls,
 * while never being stale enough to matter for scoring decisions:
 *   - intraday frames: TTL ≈ a few bar-widths
 *   - 1d: long TTL — the daily bar doesn't change intraday
 * Unknown timeframes fall back to a conservative 60s.
 */
const HISTORICAL_CACHE_TTL_MS: Record<string, number> = {
  '1m': 45 * 1000,
  '3m': 2 * 60 * 1000,
  '5m': 4 * 60 * 1000,
  '10m': 7 * 60 * 1000,
  '15m': 10 * 60 * 1000,
  '30m': 20 * 60 * 1000,
  '1h': 40 * 60 * 1000,
  '1d': 2 * 60 * 60 * 1000,
};
const HISTORICAL_CACHE_TTL_DEFAULT_MS = 60 * 1000;

/**
 * Thrown when Angel One's historical endpoint responds with `data: null`
 * (as opposed to `data: []`). Empirically this is the throttle / auth-
 * rejection shape — Angel returns HTTP 200 with a null `data` field and a
 * `message` like "Access denied because of exceeding access rate". A
 * genuine "no candles in this window" response is `data: []`.
 *
 * Surfacing this as a distinct, named error lets callers (e.g. the Chartink
 * scoring service) tell "the broker throttled us" apart from "no data" —
 * the former marks the score `dataStarved` and suppresses false stop-outs,
 * the latter is a genuine signal failure. The `name` is set explicitly so
 * the marker survives serialization / `instanceof` across module boundaries.
 */
export class AngelThrottleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AngelThrottleError';
    // Restore prototype chain — required when targeting ES5/ES2015 down-level.
    Object.setPrototypeOf(this, AngelThrottleError.prototype);
  }
}

@Injectable()
export class AngelOneAdapterService implements BrokerAdapter {
  private readonly logger = new Logger(AngelOneAdapterService.name);

  /**
   * Serialized promise chain for ALL historical SmartAPI calls (across all
   * callers). Without this, multiple concurrent fetches (scoring's ~8-10
   * back-to-back calls) can saturate Angel One's 3 req/sec hard cap; Angel
   * silently returns empty data when exceeded. The chunker's own pacer
   * only serializes WITHIN one getHistoricalData call — this one serializes
   * BETWEEN all calls.
   */
  private historicalChain: Promise<unknown> = Promise.resolve();
  private lastHistoricalCallAt = 0;

  /**
   * Most-recent tick per token captured directly off the WebSocket feed.
   *
   * Angel One's REST `/rest/secure/angelbroking/market/v1/quote` endpoint
   * (the SDK's `marketData` call) returns HTTP 403 for any client whose
   * SmartAPI subscription does not include the paid "Market Data API"
   * product. That is true for index tokens (NIFTY=99926000, BANKNIFTY=
   * 99926009 and the rest of the 99926xxx family) and for MCX commodity
   * tokens, even though the same tokens stream fine over the WebSocket.
   * The 403 has nothing to do with payload shape — every documented
   * variant (mode FULL/OHLC/LTP, exchange "NSE"/"NSE_CM", payload
   * `exchangeTokens: { NSE: ['99926000'] }`) returns the same response.
   *
   * Rather than break live-quote consumers, we mirror every WebSocket
   * tick into this cache and serve from it when the REST call fails.
   * This gives us correct LTP/OHLC/volume for indices and commodities
   * as long as the WS feed is up — which it always is during market
   * hours, since MarketFeedService keeps a persistent connection.
   */
  private readonly wsTickCache = new Map<string, TickData>();

  /**
   * 5-level market depth, cached for 1.5s per `${exchange}:${token}` key.
   * Frontend MarketDepthCard polls at 2s intervals so this prevents tight
   * double-calls into Angel One's marketData(FULL) endpoint without ever
   * being too stale to be useful (depth changes meaningfully on the order
   * of sub-second, but for a UI ladder 1.5s lag is invisible).
   */
  private readonly depthCache = new Map<
    string,
    { data: MarketDepth; expiresAt: number }
  >();
  private static readonly DEPTH_TTL_MS = 1500;

  /**
   * In-memory TTL cache for `getHistoricalData`, keyed by
   * `${token}:${exchange}:${timeframe}`. A re-scoring pass over ~100 watch
   * entries would otherwise issue ~600 fresh broker calls; many of those
   * are for shared tokens (NIFTY, sector indices) or stocks fetched
   * seconds earlier. Caching the merged candle array per key collapses
   * those duplicates without hitting Angel One's 3 req/sec limit.
   *
   * CONTRACT (mirrors the depthCache style):
   *   - Only SUCCESSFUL, NON-EMPTY results are stored. An empty array
   *     (genuine `data:[]`) or a throttle (`data:null` → AngelThrottleError)
   *     is never cached — re-requesting must re-hit the broker so a
   *     transient miss self-heals.
   *   - TTL is per-timeframe (see HISTORICAL_CACHE_TTL_MS). Expired entries
   *     are refetched on next access.
   *   - The cache key intentionally ignores the [from,to] range: scoring
   *     always asks for "the last N bars up to now", so a slightly-older
   *     cached window of the same timeframe is an acceptable, in-TTL
   *     substitute. Callers needing an exact historical range should not
   *     rely on this cache being range-precise.
   */
  private readonly historicalCache = new Map<
    string,
    { data: any[]; expiresAt: number }
  >();

  constructor(
    public readonly authService: AngelOneAuthService,
    private readonly wsService: AngelOneWebSocketService,
  ) {
    // Mirror every WS tick into the local cache. The wsService is an
    // EventEmitter shared with MarketFeedService; adding our own listener
    // here is non-destructive (setMaxListeners is 100).
    this.wsService.on('tick', (tick: TickData) => {
      if (tick?.token) {
        this.wsTickCache.set(String(tick.token), tick);
      }
    });
  }

  // ─────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.logger.log('Connecting to Angel One SmartAPI');
    if (!this.authService.isAuthenticated()) {
      await this.authService.login();
    }
    await this.wsService.connect();
    this.logger.log('Angel One adapter connected');
  }

  async disconnect(): Promise<void> {
    this.logger.log('Disconnecting from Angel One SmartAPI');
    await this.wsService.disconnect();
    await this.authService.logout();
    this.logger.log('Angel One adapter disconnected');
  }

  // ─────────────────────────────────────────────────────
  // Orders
  // ─────────────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    try {
      const smartApi = this.authService.getSmartApi();

      const params: Record<string, string> = {
        variety: 'NORMAL',
        tradingsymbol: order.symbol,
        symboltoken: order.token,
        transactiontype: order.side,
        exchange: order.exchange,
        ordertype: ORDER_TYPE_MAP[order.orderType] ?? order.orderType,
        producttype: PRODUCT_TYPE_MAP[order.positionType] ?? order.positionType,
        duration: 'DAY',
        quantity: String(order.quantity),
      };

      if (order.price != null && order.price > 0) {
        params.price = String(order.price);
      } else {
        params.price = '0';
      }

      if (order.triggerPrice != null && order.triggerPrice > 0) {
        params.triggerprice = String(order.triggerPrice);
      } else {
        params.triggerprice = '0';
      }

      this.logger.log(
        `Placing ${order.orderType} ${order.side} order for ${order.symbol} qty=${order.quantity}`,
      );

      const response = await smartApi.placeOrder(params);

      if (!response?.data?.orderid) {
        return {
          orderId: '',
          status: 'REJECTED',
          message: response?.message ?? 'Order placement failed',
        };
      }

      return {
        orderId: response.data.orderid,
        status: 'PLACED',
        message: response.message ?? 'Order placed successfully',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to place order: ${msg}`);
      return {
        orderId: '',
        status: 'FAILED',
        message: msg,
      };
    }
  }

  async modifyOrder(
    orderId: string,
    updates: Partial<OrderRequest>,
  ): Promise<OrderResponse> {
    try {
      const smartApi = this.authService.getSmartApi();

      const params: Record<string, string> = {
        variety: 'NORMAL',
        orderid: orderId,
      };

      if (updates.orderType) {
        params.ordertype = ORDER_TYPE_MAP[updates.orderType] ?? updates.orderType;
      }
      if (updates.quantity != null) {
        params.quantity = String(updates.quantity);
      }
      if (updates.price != null) {
        params.price = String(updates.price);
      }
      if (updates.triggerPrice != null) {
        params.triggerprice = String(updates.triggerPrice);
      }

      this.logger.log(`Modifying order ${orderId}`);
      const response = await smartApi.modifyOrder(params);

      if (!response?.data?.orderid) {
        return {
          orderId,
          status: 'REJECTED',
          message: response?.message ?? 'Order modification failed',
        };
      }

      return {
        orderId: response.data.orderid,
        status: 'MODIFIED',
        message: response.message ?? 'Order modified successfully',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to modify order ${orderId}: ${msg}`);
      return {
        orderId,
        status: 'FAILED',
        message: msg,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      const smartApi = this.authService.getSmartApi();

      this.logger.log(`Cancelling order ${orderId}`);
      const response = await smartApi.cancelOrder({
        variety: 'NORMAL',
        orderid: orderId,
      });

      if (!response?.status) {
        throw new Error(response?.message ?? 'Order cancellation failed');
      }

      this.logger.log(`Order ${orderId} cancelled successfully`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to cancel order ${orderId}: ${msg}`);
      throw new Error(`Cancel order failed: ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────
  // Positions & Orders
  // ─────────────────────────────────────────────────────

  async getPositions(): Promise<PositionData[]> {
    try {
      const smartApi = this.authService.getSmartApi();
      const response = await smartApi.getPosition();

      if (!response?.data) {
        return [];
      }

      const positions: any[] = Array.isArray(response.data)
        ? response.data
        : response.data.net ?? response.data.day ?? [];

      return positions.map((p: any) => ({
        symbol: p.tradingsymbol ?? p.symbolname ?? '',
        exchange: p.exchange ?? '',
        side: Number(p.netqty ?? p.buyqty ?? 0) >= 0 ? 'BUY' : 'SELL',
        quantity: Math.abs(Number(p.netqty ?? 0)),
        averagePrice: Number(p.averageprice ?? p.netprice ?? 0),
        ltp: Number(p.ltp ?? 0),
        pnl: Number(p.pnl ?? p.unrealised ?? p.realised ?? 0),
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch positions: ${msg}`);
      throw new Error(`Get positions failed: ${msg}`);
    }
  }

  async getOrders(): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();
      const response = await smartApi.getOrderBook();

      if (!response?.data) {
        return [];
      }

      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch order book: ${msg}`);
      throw new Error(`Get orders failed: ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────
  // Market data — REST
  // ─────────────────────────────────────────────────────

  async getLiveQuote(token: string, exchange: string): Promise<TickData> {
    // Try the REST quote endpoint first. It returns the freshest snapshot
    // (with proper prev-close) for any token the API key is entitled to.
    try {
      const smartApi = this.authService.getSmartApi();

      const response = await smartApi.marketData({
        mode: 'FULL',
        exchangeTokens: { [exchange]: [token] },
      });

      if (response?.data?.fetched?.length) {
        const d = response.data.fetched[0];
        return {
          token: String(d.symbolToken ?? d.symboltoken ?? token),
          symbol: d.tradingSymbol ?? d.tradingsymbol ?? '',
          ltp: Number(d.ltp ?? 0),
          open: Number(d.open ?? 0),
          high: Number(d.high ?? 0),
          low: Number(d.low ?? 0),
          close: Number(d.close ?? 0),
          volume: Number(d.tradeVolume ?? d.volume ?? 0),
          oi: d.opnInterest != null ? Number(d.opnInterest) : undefined,
          timestamp: new Date(),
        };
      }

      // REST returned no data — usually 403 for index/MCX tokens that this
      // API key isn't entitled to. Fall through to WS-cache fallback.
      const restStatus = response?.status;
      const restMessage = response?.message;
      this.logger.debug(
        `marketData REST returned no data for ${token}/${exchange} ` +
          `(status=${restStatus} message="${restMessage}") — trying WS cache`,
      );

      const cached = this.wsTickCache.get(String(token));
      if (cached) return cached;

      // No REST data and no WS tick yet — surface the original REST error.
      throw new Error(restMessage ?? 'Market data fetch failed');
    } catch (error) {
      // Any error (network, 403, parse, etc.): try the WS cache before giving up.
      const cached = this.wsTickCache.get(String(token));
      if (cached) {
        return cached;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get live quote for ${token}: ${msg}`);
      throw new Error(`Get live quote failed: ${msg}`);
    }
  }

  /**
   * Fetch 5-level market depth (bids + asks) for a single token.
   *
   * Wraps Angel One `marketData({ mode: 'FULL', ... })`, which returns a
   * `depth: { buy: [...5], sell: [...5] }` block on the entry inside
   * `data.fetched[]`. Cached for 1.5s per exchange:token to absorb the
   * frontend's 2s polling cadence without hammering SmartAPI.
   *
   * Returns `null` (not throws) when:
   *   - the token isn't entitled (403) — typical for indices that have
   *     no order book anyway
   *   - the response shape is unexpected
   *   - any network / SDK error
   * The frontend renders "Depth unavailable" on null, so failure modes
   * degrade gracefully without blocking the rest of the panel.
   */
  async getMarketDepth(
    token: string,
    exchange: string,
  ): Promise<MarketDepth | null> {
    const key = `${exchange}:${token}`;
    const cached = this.depthCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      const smartApi = this.authService.getSmartApi();
      const response = await smartApi.marketData({
        mode: 'FULL',
        exchangeTokens: { [exchange]: [token] },
      });

      const node = response?.data?.fetched?.[0];
      if (!node) {
        this.logger.debug(
          `getMarketDepth: no data fetched for ${exchange}:${token} ` +
            `(status=${response?.status} message="${response?.message}")`,
        );
        return null;
      }

      // Angel One docs name the keys `buy` / `sell` and each level carries
      // `price`, `quantity`, `orders`. Some SDK versions camelCase them
      // (`bestBids` / `bestAsks`) — fall back through both shapes.
      const rawBuy: any[] =
        node.depth?.buy ??
        node.depth?.bestBids ??
        node.bestBids ??
        node.buy ??
        [];
      const rawSell: any[] =
        node.depth?.sell ??
        node.depth?.bestAsks ??
        node.bestAsks ??
        node.sell ??
        [];

      const mapLevel = (l: any): MarketDepthLevel => ({
        price: Number(l?.price ?? l?.Price ?? 0),
        qty: Number(l?.quantity ?? l?.qty ?? l?.Quantity ?? 0),
        orders: Number(l?.orders ?? l?.noOfOrders ?? l?.NoOfOrders ?? 0),
      });

      const bids = (Array.isArray(rawBuy) ? rawBuy : [])
        .slice(0, 5)
        .map(mapLevel)
        .filter((l) => l.price > 0);
      const asks = (Array.isArray(rawSell) ? rawSell : [])
        .slice(0, 5)
        .map(mapLevel)
        .filter((l) => l.price > 0);

      if (bids.length === 0 && asks.length === 0) {
        // Token returned no depth (indices, illiquid scrips). Cache the
        // empty result briefly anyway so we don't refetch on every poll.
        const empty: MarketDepth = {
          token,
          exchange,
          bids,
          asks,
          totalBidQty: 0,
          totalAskQty: 0,
          ts: Date.now(),
        };
        this.depthCache.set(key, {
          data: empty,
          expiresAt: Date.now() + AngelOneAdapterService.DEPTH_TTL_MS,
        });
        return empty;
      }

      const totalBidQty = bids.reduce((s, l) => s + l.qty, 0);
      const totalAskQty = asks.reduce((s, l) => s + l.qty, 0);

      const depth: MarketDepth = {
        token,
        exchange,
        bids,
        asks,
        totalBidQty,
        totalAskQty,
        ts: Date.now(),
      };
      this.depthCache.set(key, {
        data: depth,
        expiresAt: Date.now() + AngelOneAdapterService.DEPTH_TTL_MS,
      });
      return depth;
    } catch (err) {
      this.logger.warn(
        `getMarketDepth failed for ${exchange}:${token}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Fetch historical candles, auto-chunking the date range to stay within
   * Angel One's per-interval window limits (see TIMEFRAME_MAX_RANGE_DAYS).
   *
   * Angel One's getCandleData silently returns HTTP 200 + empty `data` when
   * the range exceeds the limit for the requested interval — so callers
   * who pass a wide range used to think the broker had no data when really
   * they were over the limit. This wrapper splits the range into safe
   * chunks, paces each call (350ms — Angel historical is 3 req/sec), and
   * concatenates results. Caller sees one logical fetch.
   *
   * Order of returned candles is chronological (chunks fetched oldest →
   * newest); deduplicated on timestamp in case Angel returns overlapping
   * boundary bars between consecutive chunks.
   */
  async getHistoricalData(
    token: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
  ): Promise<any[]> {
    // ─── TTL cache (Task B) ───────────────────────────────────────────
    // Serve repeated fetches of the same (token, exchange, timeframe)
    // within the per-timeframe TTL without re-hitting the broker. Only
    // successful, non-empty results are cached (see historicalCache docs).
    const cacheKey = `${token}:${exchange}:${timeframe}`;
    const cached = this.historicalCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // Contain a throttle at this boundary. fetchHistoricalChunk raises a
    // typed AngelThrottleError so the throttle is detectable + logged, but
    // every caller of getHistoricalData keeps the historical "[] on failure"
    // contract — no caller needs its own try/catch. The empty result is not
    // cached, so the next call self-heals; the scoring service still flags
    // dataStarved off the empty candle set.
    let result: any[];
    try {
      result = await this.getHistoricalDataUncached(
        token,
        exchange,
        timeframe,
        from,
        to,
      );
    } catch (err) {
      if (err instanceof AngelThrottleError) {
        this.logger.warn(
          `getHistoricalData throttled for ${cacheKey} — returning [] ` +
            `(not cached): ${err.message}`,
        );
        return [];
      }
      throw err;
    }

    // Cache ONLY a genuine non-empty result. An empty array (data:[]) or a
    // contained throttle must not be cached, so a transient miss self-heals
    // on the next call.
    if (result.length > 0) {
      const ttl =
        HISTORICAL_CACHE_TTL_MS[timeframe] ?? HISTORICAL_CACHE_TTL_DEFAULT_MS;
      this.historicalCache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + ttl,
      });
    }
    return result;
  }

  /**
   * Uncached historical fetch — the original auto-chunking implementation.
   * `getHistoricalData` wraps this with the TTL cache. Kept private so all
   * callers go through the cache.
   */
  private async getHistoricalDataUncached(
    token: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
  ): Promise<any[]> {
    const interval = TIMEFRAME_MAP[timeframe] ?? timeframe;
    const maxDays = TIMEFRAME_MAX_RANGE_DAYS[interval] ?? 30; // conservative default if interval unknown
    const maxRangeMs = maxDays * 24 * 60 * 60 * 1000;
    const totalRangeMs = to.getTime() - from.getTime();

    // Single-shot path — range fits within Angel's limit, no chunking needed.
    if (totalRangeMs <= maxRangeMs) {
      return this.fetchHistoricalChunk(token, exchange, interval, from, to);
    }

    // Multi-chunk path — slice into [maxDays]-wide windows.
    this.logger.log(
      `Auto-chunking historical fetch: token=${token} interval=${interval} ` +
      `range=${(totalRangeMs / (24 * 60 * 60 * 1000)).toFixed(1)}d > limit=${maxDays}d`,
    );

    const merged: any[] = [];
    const seenTs = new Set<number>();
    let cursor = from.getTime();
    let chunkIndex = 0;
    while (cursor < to.getTime()) {
      const chunkEnd = Math.min(cursor + maxRangeMs, to.getTime());
      const chunk = await this.fetchHistoricalChunk(
        token,
        exchange,
        interval,
        new Date(cursor),
        new Date(chunkEnd),
      );
      for (const c of chunk) {
        const ts = c.timestamp.getTime();
        if (!seenTs.has(ts)) {
          seenTs.add(ts);
          merged.push(c);
        }
      }
      chunkIndex++;
      // Pacer between chunks — only sleep when there's another chunk to fetch.
      if (chunkEnd < to.getTime()) {
        await new Promise((resolve) => setTimeout(resolve, HISTORICAL_CHUNK_PACE_MS));
      }
      cursor = chunkEnd;
    }

    this.logger.log(
      `Auto-chunked fetch complete: ${chunkIndex} chunks → ${merged.length} unique candles`,
    );
    // Sort by timestamp ascending so callers can rely on chronological order.
    merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return merged;
  }

  /**
   * Single-call historical fetch — direct passthrough to Angel One. Used
   * by the chunking wrapper above; do not call directly from outside the
   * adapter unless you've already validated the range is within
   * TIMEFRAME_MAX_RANGE_DAYS for the interval.
   */
  private async fetchHistoricalChunk(
    token: string,
    exchange: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();

      const fromStr = this.formatDateTime(from);
      const toStr = this.formatDateTime(to);

      this.logger.log(
        `Fetching historical data: token=${token} exchange=${exchange} interval=${interval} ${fromStr} to ${toStr}`,
      );

      const response: any = await this.serializeHistoricalCall<any>(() =>
        smartApi.getCandleData({
          exchange,
          symboltoken: token,
          interval,
          fromdate: fromStr,
          todate: toStr,
        }),
      );

      // Temporary diagnostic — log the raw shape so we can tell empty-array
      // (data:[]) apart from auth/throttle errors (data:null, message:"...").
      this.logger.log(
        `Historical raw: token=${token} status=${response?.status} message=${response?.message ?? '-'} errorcode=${response?.errorcode ?? '-'} dataLen=${Array.isArray(response?.data) ? response.data.length : 'n/a'}`,
      );

      // Distinguish the two "no rows" shapes:
      //   - data: []   → genuine empty window (weekend/holiday/pre-listing).
      //                  Return [] so callers see "no candles", not an error.
      //   - data: null → Angel rejected the call: throttle (3 req/sec cap
      //                  exceeded) or auth failure. This is NOT "no data" —
      //                  surface it as a typed AngelThrottleError so callers
      //                  can mark the result data-starved instead of
      //                  mistaking it for a genuine empty series.
      if (response?.data == null) {
        throw new AngelThrottleError(
          `Angel One historical fetch rejected (data:null) for token=${token} ` +
            `interval=${interval}: ${response?.message ?? 'no message'} ` +
            `(errorcode=${response?.errorcode ?? '-'})`,
        );
      }
      if (!Array.isArray(response.data)) {
        return [];
      }

      // SmartAPI returns candles as arrays: [timestamp, open, high, low, close, volume]
      return (response.data as any[]).map((candle: any[]) => ({
        timestamp: new Date(candle[0]),
        open: Number(candle[1]),
        high: Number(candle[2]),
        low: Number(candle[3]),
        close: Number(candle[4]),
        volume: Number(candle[5]),
      }));
    } catch (error) {
      // Re-throw a throttle error AS-IS so its `AngelThrottleError` type and
      // `name` survive — callers depend on that marker to tell throttle
      // apart from a generic fetch failure. Wrapping it in a plain Error
      // (as below) would erase the distinction.
      if (error instanceof AngelThrottleError) {
        this.logger.warn(`Historical fetch throttled: ${error.message}`);
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch historical data: ${msg}`);
      throw new Error(`Get historical data failed: ${msg}`);
    }
  }

  async searchInstruments(query: string, exchange = 'NFO'): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();

      // SmartAPI searchScrip returns data.data directly (already extracted by SDK)
      const result = await smartApi.searchScrip({
        exchange,
        searchscrip: query,
      });

      // The SDK may return the array directly, or wrapped in { data: [...] }
      if (Array.isArray(result)) return result;
      if (result?.data && Array.isArray(result.data)) return result.data;
      return [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Instrument search failed for "${query}" on ${exchange}: ${msg}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────
  // Market data — WebSocket
  // ─────────────────────────────────────────────────────

  subscribeToFeed(tokens: string[], callback: FeedCallback): void {
    // Register the callback for tick events
    this.wsService.on('tick', callback);

    // Separate tokens by exchange — each exchange needs its own exchangeType
    // on the Angel One WebSocket or subscriptions are silently dropped.
    const mcxTokens = new Set<string>();
    for (const c of Object.values(COMMODITIES)) {
      if (c.token && c.token !== '0') mcxTokens.add(c.token);
    }

    const nseTokenList: string[] = [];
    const bseTokenList: string[] = [];
    const mcxTokenList: string[] = [];
    for (const t of tokens) {
      if (mcxTokens.has(t)) mcxTokenList.push(t);
      else if (BSE_TOKENS.has(t)) bseTokenList.push(t);
      else nseTokenList.push(t);
    }

    // Subscribe NSE tokens
    if (nseTokenList.length > 0) {
      this.wsService
        .subscribe(nseTokenList, WsFeedMode.SNAP_QUOTE, ExchangeType.NSE_CM)
        .catch((error) => {
          this.logger.error(
            `NSE feed subscription failed: ${error instanceof Error ? error.message : error}`,
          );
        });
    }

    // Subscribe BSE tokens (SENSEX etc.)
    if (bseTokenList.length > 0) {
      this.wsService
        .subscribe(bseTokenList, WsFeedMode.SNAP_QUOTE, ExchangeType.BSE_CM)
        .catch((error) => {
          this.logger.error(
            `BSE feed subscription failed: ${error instanceof Error ? error.message : error}`,
          );
        });
    }

    // Subscribe MCX tokens
    if (mcxTokenList.length > 0) {
      this.wsService
        .subscribe(mcxTokenList, WsFeedMode.SNAP_QUOTE, ExchangeType.MCX_FO)
        .catch((error) => {
          this.logger.error(
            `MCX feed subscription failed: ${error instanceof Error ? error.message : error}`,
          );
        });
    }
  }

  unsubscribeFromFeed(tokens: string[]): void {
    this.wsService.unsubscribe(tokens).catch((error) => {
      this.logger.error(
        `Feed unsubscription failed: ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  /**
   * Single-token subscription with explicit exchange. Maps a string
   * exchange code (NSE / BSE / MCX / NFO) to the Angel One ExchangeType
   * enum, then registers the WS feed. Used by the chart's ad-hoc
   * "viewing" subscription path.
   */
  async subscribeAdHoc(token: string, exchange: string): Promise<void> {
    const exType = this.mapExchangeToWsType(exchange);
    if (!exType) {
      this.logger.warn(`subscribeAdHoc: unknown exchange "${exchange}" — skipping`);
      return;
    }
    try {
      await this.wsService.subscribe([token], WsFeedMode.SNAP_QUOTE, exType);
    } catch (error) {
      this.logger.error(
        `Ad-hoc feed subscription failed for ${token}/${exchange}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private mapExchangeToWsType(exchange: string): ExchangeType | null {
    switch (exchange.toUpperCase()) {
      case 'NSE': return ExchangeType.NSE_CM;
      case 'BSE': return ExchangeType.BSE_CM;
      case 'MCX': return ExchangeType.MCX_FO;
      case 'NFO': return ExchangeType.NSE_FO;
      default: return null;
    }
  }

  // ─────────────────────────────────────────────────────
  // Instrument master (OpenAPI ScripMaster)
  // ─────────────────────────────────────────────────────

  /**
   * Download the full Angel One instrument master list from the public CDN.
   * Returns raw records for the requested exchange/segment.
   *
   * The file at this URL is a JSON array of objects like:
   * { token, symbol, name, expiry, strike, lotsize, instrumenttype,
   *   exch_seg, tick_size, ... }
   *
   * instrumenttype for options: "OPTIDX" (index options) or "OPTSTK" (stock options)
   * exch_seg: "NFO" for F&O segment
   */
  /** In-memory cache for the public ScripMaster (~200k rows). Reused by
   * fetchInstrumentMaster() and searchInMaster(); refreshed lazily. */
  private masterCache: any[] | null = null;
  private masterCacheLoadedAt: number = 0;
  private static readonly MASTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private masterCacheLoading: Promise<any[]> | null = null;

  private async ensureMasterCache(): Promise<any[]> {
    const fresh =
      this.masterCache &&
      Date.now() - this.masterCacheLoadedAt < AngelOneAdapterService.MASTER_CACHE_TTL_MS;
    if (fresh) return this.masterCache!;
    if (this.masterCacheLoading) return this.masterCacheLoading;

    this.masterCacheLoading = (async () => {
      const url =
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
      this.logger.log('Downloading instrument master from Angel One CDN');
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download instrument master: HTTP ${response.status}`);
      }
      const all: any[] = await response.json();
      this.logger.log(`Downloaded ${all.length} total instruments from Angel One`);
      this.masterCache = all;
      this.masterCacheLoadedAt = Date.now();
      return all;
    })();

    try {
      return await this.masterCacheLoading;
    } finally {
      this.masterCacheLoading = null;
    }
  }

  async fetchInstrumentMaster(exchange: string = 'NFO'): Promise<any[]> {
    const all = await this.ensureMasterCache();
    const filtered = all.filter((i: any) => i.exch_seg === exchange);
    this.logger.log(`Filtered to ${filtered.length} instruments for ${exchange}`);
    return filtered;
  }

  /**
   * Resolve company-name searches via Yahoo Finance. Angel One's master
   * carries only trading symbols (the `name` field for NSE-EQ rows is
   * just the symbol again), so a user typing "Varun Beverages" finds
   * nothing locally. Yahoo's free search API maps the company name to
   * a ticker like VBL.NS, which we then look up in the master.
   *
   * Returns an array of trading-symbol prefixes (no exchange suffix)
   * that the caller can use to filter the master cache.
   */
  private async resolveNameToSymbols(query: string): Promise<Array<{ symbol: string; exchange: 'NSE' | 'BSE' }>> {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { quotes?: Array<{ symbol?: string }> };
      const out: Array<{ symbol: string; exchange: 'NSE' | 'BSE' }> = [];
      for (const q of data.quotes ?? []) {
        const yahooSym = q.symbol ?? '';
        if (yahooSym.endsWith('.NS')) {
          out.push({ symbol: yahooSym.slice(0, -3), exchange: 'NSE' });
        } else if (yahooSym.endsWith('.BO')) {
          out.push({ symbol: yahooSym.slice(0, -3), exchange: 'BSE' });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Search the cached ScripMaster by symbol OR company name. Combines
   * three matchers:
   * 1. Direct symbol match in the master (cash-equity NSE/BSE).
   * 2. Yahoo-resolved name → symbol → master lookup (covers "Varun
   *    Beverages" → VBL → token 18921).
   *
   * Filters to EQ on NSE/BSE by default; F&O contracts would swamp.
   */
  async searchInMaster(
    query: string,
    options: { exchanges?: string[]; limit?: number } = {},
  ): Promise<any[]> {
    const exchanges = options.exchanges ?? ['NSE', 'BSE'];
    const limit = options.limit ?? 25;
    const q = query.trim().toUpperCase();
    if (q.length < 2) return [];

    const all = await this.ensureMasterCache();
    const isEqRow = (inst: any): boolean => {
      const sym = String(inst.symbol ?? '').toUpperCase();
      return inst.exch_seg === 'NSE' ? sym.endsWith('-EQ') : inst.exch_seg === 'BSE';
    };

    const matches: any[] = [];
    const seen = new Set<string>();

    for (const inst of all) {
      if (!exchanges.includes(inst.exch_seg)) continue;
      if (!isEqRow(inst)) continue;
      const sym = String(inst.symbol ?? '').toUpperCase();
      const name = String(inst.name ?? '').toUpperCase();
      if (sym.includes(q) || name.includes(q)) {
        matches.push(inst);
        seen.add(String(inst.token ?? ''));
        if (matches.length >= limit) break;
      }
    }

    // If we have headroom, ask Yahoo to map the query to tickers and
    // pull the matching master rows. Skips when query is short or
    // already produced enough matches.
    if (matches.length < limit && q.length >= 3) {
      const resolved = await this.resolveNameToSymbols(query);
      for (const r of resolved) {
        if (!exchanges.includes(r.exchange)) continue;
        const wanted = r.exchange === 'NSE' ? `${r.symbol}-EQ` : r.symbol;
        const wantedUpper = wanted.toUpperCase();
        for (const inst of all) {
          if (inst.exch_seg !== r.exchange) continue;
          if (!isEqRow(inst)) continue;
          if (String(inst.symbol ?? '').toUpperCase() !== wantedUpper) continue;
          const tk = String(inst.token ?? '');
          if (seen.has(tk)) break;
          matches.push(inst);
          seen.add(tk);
          break;
        }
        if (matches.length >= limit) break;
      }
    }

    return matches;
  }

  /**
   * Get option contracts for a specific underlying from the Angel One master list.
   * Filters by underlying name and returns option-specific fields.
   */
  async getOptionContracts(
    underlying: string,
    instrumentMaster?: any[],
  ): Promise<
    Array<{
      token: string;
      symbol: string;
      name: string;
      exchange: string;
      expiry: Date;
      strike: number;
      optionType: 'CE' | 'PE';
      lotSize: number;
    }>
  > {
    const upperUnderlyingRaw = underlying.toUpperCase();
    const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(
      upperUnderlyingRaw,
    );
    const isMcxCommodity = ['CRUDEOIL', 'COPPER', 'GOLD', 'SILVER', 'NATURALGAS'].includes(
      upperUnderlyingRaw,
    );

    // MCX commodity options live on the MCX segment (exch_seg='MCX') and use
    // instrumenttype 'OPTFUT' because they're options-on-futures, not
    // options-on-index/stock. NFO uses OPTIDX/OPTSTK.
    const masterExchange = isMcxCommodity ? 'MCX' : 'NFO';
    const master =
      instrumentMaster ?? (await this.fetchInstrumentMaster(masterExchange));

    // Angel One uses "OPTIDX" for index options, "OPTSTK" for stock options,
    // and "OPTFUT" for options on MCX futures (CRUDEOIL, COPPER, etc).
    const instrumentTypes = isMcxCommodity
      ? ['OPTFUT']
      : isIndex
      ? ['OPTIDX']
      : ['OPTSTK'];

    const upperUnderlying = upperUnderlyingRaw;

    const options = master
      .filter((i: any) => {
        if (!instrumentTypes.includes(i.instrumenttype)) return false;
        // The "name" field in the master contains the underlying name
        // e.g., "NIFTY", "BANKNIFTY"
        if ((i.name ?? '').toUpperCase() !== upperUnderlying) return false;
        // Must have strike and expiry
        if (!i.strike || !i.expiry) return false;
        return true;
      })
      .map((i: any) => {
        // Parse expiry: format is "DDMMMYYYY" e.g., "27MAR2026"
        // or sometimes "27Mar2026"
        const expiryStr = String(i.expiry).trim();
        let expiry: Date;
        try {
          expiry = new Date(expiryStr);
          if (isNaN(expiry.getTime())) {
            // Try manual parsing: DDMMMYYYY
            const months: Record<string, number> = {
              JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
              JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
            };
            const day = parseInt(expiryStr.substring(0, 2));
            const mon = months[expiryStr.substring(2, 5).toUpperCase()];
            const year = parseInt(expiryStr.substring(5));
            expiry = new Date(year, mon, day);
          }
        } catch {
          expiry = new Date(expiryStr);
        }

        // Strike in the master is a string like "22500.000000" or "22500"
        const strike = parseFloat(String(i.strike));

        // Determine option type from the symbol suffix
        // Symbols end with CE or PE, e.g., "NIFTY27MAR2622500CE"
        const sym = String(i.symbol).toUpperCase();
        const optionType = sym.endsWith('PE') ? 'PE' : 'CE';

        return {
          token: String(i.token),
          symbol: String(i.symbol),
          name: String(i.name ?? underlying),
          // Preserve the master's segment string so downstream live-quote
          // calls route MCX options to MCX and NFO options to NFO.
          exchange: String(i.exch_seg ?? masterExchange),
          expiry,
          strike,
          optionType: optionType as 'CE' | 'PE',
          lotSize: parseInt(String(i.lotsize ?? '1')) || 1,
        };
      })
      .filter((o: { expiry: Date }) => {
        if (isNaN(o.expiry.getTime())) return false;
        // Keep contracts whose expiry day is today or later. Comparing to
        // `new Date()` (now) drops same-day expiries after midnight, hiding
        // 0-DTE options from consumers — which breaks live-quote lookups for
        // any trade placed on its expiry day.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        return o.expiry >= startOfToday;
      });

    this.logger.log(
      `Found ${options.length} active option contracts for ${underlying}`,
    );

    return options;
  }

  // ─────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────

  /**
   * Format a Date to the string format expected by Angel One: "YYYY-MM-DD HH:mm"
   */
  /**
   * Serialize a historical SmartAPI call so AT MOST one is in-flight at a
   * time AND a minimum gap is enforced between consecutive calls (across
   * all callers). Prevents Angel One's 3 req/sec hard cap from silently
   * dropping bursts (e.g. scoring's 8-10 calls in succession).
   */
  private serializeHistoricalCall<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.historicalChain.then(async () => {
      const elapsed = Date.now() - this.lastHistoricalCallAt;
      const wait = Math.max(0, HISTORICAL_MIN_GAP_MS - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastHistoricalCallAt = Date.now();
      return fn();
    });
    // Don't propagate errors into the chain — one failed call must not
    // permanently block subsequent ones.
    this.historicalChain = next.catch(() => undefined);
    return next;
  }

  private formatDateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
}
