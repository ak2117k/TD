/**
 * Models that carry a `userId` scalar and are therefore tenant-owned (TDA-003).
 *
 * The Prisma tenant-scoping interceptor (Task 2) auto-injects `userId` scoping
 * for these models whenever a non-admin tenant context is active. `User` is
 * deliberately absent — it is the tenant root (keyed by `id`), and global/IP
 * models (Signal, Candle, …) are never scoped.
 *
 * Keep verbatim in sync with the schema; a missing name here is a silent
 * isolation hole.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'Trade',
  'UserSettings',
  'DailyPerformance',
  'Alert',
  'AITradeAnalysis',
  'AIWeeklyReport',
  'BrokerCredential',
  'Subscription',
  'AutoTradeConsent',
  'ConsentRecord',
  'RefreshToken',
  'VerificationToken',
]);
