import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WS_NAMESPACE } from '@td/shared/constants';
import { Quote, OIData } from '@td/shared/types';

export interface CandlePayload {
  token: string;
  timeframe: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ConnectionStatusPayload {
  connected: boolean;
  activeSubscriptions: number;
  timestamp: Date;
}

@WebSocketGateway({
  namespace: WS_NAMESPACE,
  cors: {
    origin: 'http://localhost:3000',
    credentials: true,
  },
  transports: ['polling', 'websocket'],
})
export class MarketDataGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MarketDataGateway.name);

  @WebSocketServer()
  server: Server;

  /** Track which tokens each client is interested in. */
  private readonly clientSubscriptions = new Map<string, Set<string>>();

  afterInit(): void {
    this.logger.log('Market Data WebSocket Gateway initialized');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSubscriptions.set(client.id, new Set());
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clientSubscriptions.delete(client.id);
  }

  /**
   * Client subscribes to specific tokens for live updates.
   * The client joins a Socket.IO room per token so we can emit targeted updates.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tokens: string[] },
  ): { event: string; data: { subscribed: string[] } } {
    const tokens = data?.tokens ?? [];
    const subs = this.clientSubscriptions.get(client.id);

    for (const token of tokens) {
      client.join(`token:${token}`);
      subs?.add(token);
    }

    this.logger.debug(
      `Client ${client.id} subscribed to ${tokens.length} tokens`,
    );

    return {
      event: 'subscribed',
      data: { subscribed: tokens },
    };
  }

  /**
   * Client unsubscribes from specific tokens.
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tokens: string[] },
  ): { event: string; data: { unsubscribed: string[] } } {
    const tokens = data?.tokens ?? [];
    const subs = this.clientSubscriptions.get(client.id);

    for (const token of tokens) {
      client.leave(`token:${token}`);
      subs?.delete(token);
    }

    this.logger.debug(
      `Client ${client.id} unsubscribed from ${tokens.length} tokens`,
    );

    return {
      event: 'unsubscribed',
      data: { unsubscribed: tokens },
    };
  }

  // ------------------------------------------------------------------
  //  Methods called by MarketFeedService to push data to clients
  // ------------------------------------------------------------------

  /**
   * Emit a tick (live price update) to all connected clients.
   *
   * We broadcast to all clients because the frontend subscribes to
   * multiple instruments (watchlist, dashboard, charts) and filters
   * by token on the client side. Using room-based targeting would
   * require the frontend to explicitly join/leave rooms on every
   * symbol change, which adds complexity. The tick payload is small
   * and the client-side token filter is reliable.
   *
   * The token field on the quote is the authoritative identifier;
   * symbol names are normalized server-side before reaching here.
   */
  emitTick(quote: Quote): void {
    this.server.emit('tick', quote);
  }

  /**
   * Emit a closed candle to all clients subscribed to that token.
   */
  emitCandle(candle: CandlePayload): void {
    this.server.emit('candle', candle);
  }

  /**
   * Emit OI update to all clients subscribed to that token.
   */
  emitOIUpdate(data: OIData): void {
    this.server.to(`token:${data.token}`).emit('oi-update', data);
  }

  /**
   * Broadcast connection status to ALL connected clients.
   */
  emitConnectionStatus(status: ConnectionStatusPayload): void {
    this.server.emit('connection-status', status);
  }

  /**
   * Get the count of currently connected clients.
   */
  getConnectedClientCount(): number {
    return this.clientSubscriptions.size;
  }
}
