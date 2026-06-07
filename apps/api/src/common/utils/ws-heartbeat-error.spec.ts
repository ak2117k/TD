import { isBenignWsHeartbeatError } from './ws-heartbeat-error';

describe('isBenignWsHeartbeatError', () => {
  it('matches the smartapi heartbeat throw on a CONNECTING socket (readyState 0)', () => {
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open: readyState 0 (CONNECTING)'))).toBe(true);
  });

  it('matches CLOSING/CLOSED sockets too (readyState 2 / 3) — the reconnect cases the old guard missed', () => {
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open: readyState 2 (CLOSING)'))).toBe(true);
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open: readyState 3 (CLOSED)'))).toBe(true);
  });

  it('matches a bare "WebSocket is not open" message with no readyState suffix', () => {
    expect(isBenignWsHeartbeatError(new Error('WebSocket is not open'))).toBe(true);
  });

  it('matches a non-Error reason carrying the same text (unhandledRejection path)', () => {
    expect(isBenignWsHeartbeatError('WebSocket is not open: readyState 3')).toBe(true);
  });

  it('does NOT match unrelated errors — real bugs must still crash loudly', () => {
    expect(isBenignWsHeartbeatError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isBenignWsHeartbeatError(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('handles null / undefined safely', () => {
    expect(isBenignWsHeartbeatError(null)).toBe(false);
    expect(isBenignWsHeartbeatError(undefined)).toBe(false);
  });
});
