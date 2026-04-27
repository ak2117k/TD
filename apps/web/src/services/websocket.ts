import { io, Socket } from 'socket.io-client';

/**
 * Frontend names for events delivered across all WebSocket namespaces.
 * Backend gateways live on three separate namespaces; this client
 * multiplexes them so consumers can subscribe by event name without
 * caring about which socket carries it.
 *
 *  /ws            — MarketDataGateway, SignalGateway
 *  /ws/trades     — TradeGateway (trade lifecycle, positions, risk)
 *  /ws/auto-trade — AutoTradeGateway (auto-execution lifecycle)
 */
export type WSEventName =
  // /ws
  | 'tick'
  | 'signal'
  | 'alert'
  | 'candle'
  // /ws/trades
  | 'trade-update'
  | 'position-update'
  | 'risk-status'
  | 'kill-switch-activated'
  // /ws/auto-trade
  | 'auto-trade:pending-approval'
  | 'auto-trade:signal-approved'
  | 'auto-trade:signal-rejected'
  | 'auto-trade:executed'
  | 'auto-trade:scan-complete'
  | 'auto-trade:error'
  // synthetic
  | 'connection-status';

type EventCallback = (data: unknown) => void;

interface NamespaceConfig {
  /** Socket.io namespace path (e.g. `/ws`, `/ws/trades`). */
  path: string;
  /** Server-emitted event names this namespace publishes. */
  events: readonly string[];
}

/**
 * Authoritative list of namespaces + the events each one carries.
 * Adding a new gateway? Add a new entry here and the rest of the app
 * picks it up automatically (subscribers route by event name).
 */
const NAMESPACES: readonly NamespaceConfig[] = [
  {
    path: '/ws',
    events: ['tick', 'signal', 'alert', 'candle'],
  },
  {
    path: '/ws/trades',
    events: [
      'trade-update',
      'position-update',
      'risk-status',
      'kill-switch-activated',
    ],
  },
  {
    path: '/ws/auto-trade',
    events: [
      'auto-trade:pending-approval',
      'auto-trade:signal-approved',
      'auto-trade:signal-rejected',
      'auto-trade:executed',
      'auto-trade:scan-complete',
      'auto-trade:error',
    ],
  },
];

class WebSocketService {
  private sockets = new Map<string, Socket>();
  private listeners = new Map<string, Set<EventCallback>>();
  /** Number of currently-connected namespace sockets. */
  private connectedCount = 0;

  connect(): void {
    if (this.sockets.size > 0) return;

    for (const ns of NAMESPACES) {
      const sock = io(ns.path, {
        path: '/socket.io',
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
      });

      sock.on('connect', () => {
        this.connectedCount++;
        console.log(`[WS] Connected: ${ns.path}`);
        // Emit on the FIRST namespace going up so connection-aware UI
        // doesn't flicker as each namespace lands. Emit on subsequent
        // ones too — listeners can dedupe via the `namespace` field.
        this.emit('connection-status', {
          connected: true,
          namespace: ns.path,
          totalConnected: this.connectedCount,
        });
      });

      sock.on('disconnect', (reason) => {
        this.connectedCount = Math.max(0, this.connectedCount - 1);
        console.log(`[WS] Disconnected ${ns.path}:`, reason);
        this.emit('connection-status', {
          connected: this.connectedCount > 0,
          namespace: ns.path,
          totalConnected: this.connectedCount,
        });
      });

      for (const event of ns.events) {
        sock.on(event, (data: unknown) => {
          this.emit(event, data);
        });
      }

      this.sockets.set(ns.path, sock);
    }
  }

  disconnect(): void {
    for (const sock of this.sockets.values()) {
      sock.disconnect();
    }
    this.sockets.clear();
    this.connectedCount = 0;
  }

  subscribe(event: string, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  get connected(): boolean {
    return this.connectedCount > 0;
  }
}

export const wsService = new WebSocketService();
