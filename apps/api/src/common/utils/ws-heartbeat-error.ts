/**
 * True when an error is the benign smartapi-javascript WebSocket heartbeat race:
 * its internal heartbeat timer calls `ws.send()` without checking readyState, so
 * during the daily reconnect (socket CONNECTING/CLOSING/CLOSED — readyState
 * 0/2/3) the `ws` library throws "WebSocket is not open: readyState N". That
 * throw escapes the library's async timer and, unhandled, kills the whole Node
 * process — taking the API (and every chart/feed) down until a manual restart.
 *
 * We swallow exactly this failure class (via both uncaughtException AND
 * unhandledRejection) so a third-party library's stray timer can never crash the
 * server. Every OTHER error is left to crash loudly so real bugs stay visible.
 *
 * Matches by message (the `ws` library's text is distinctive) rather than the
 * stack — the previous stack-based guard was too brittle and let the crash
 * through.
 */
export function isBenignWsHeartbeatError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('WebSocket is not open');
}
