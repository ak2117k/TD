import { io, Socket } from 'socket.io-client';

export type WSEventName = 'tick' | 'signal' | 'alert' | 'connection-status';

type EventCallback = (data: unknown) => void;

class WebSocketService {
  private socket: Socket | null = null;
  private listeners = new Map<string, Set<EventCallback>>();

  connect(): void {
    if (this.socket?.connected) return;

    this.socket = io('/', {
      path: '/ws',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      console.log('[WS] Connected');
      this.emit('connection-status', { connected: true });
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[WS] Disconnected:', reason);
      this.emit('connection-status', { connected: false });
    });

    const events: WSEventName[] = ['tick', 'signal', 'alert'];
    for (const event of events) {
      this.socket.on(event, (data: unknown) => {
        this.emit(event, data);
      });
    }
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
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
    return this.socket?.connected ?? false;
  }
}

export const wsService = new WebSocketService();
