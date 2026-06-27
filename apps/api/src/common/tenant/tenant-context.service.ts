import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/** The request-scoped tenant principal stored under the `'tenant'` CLS key. */
export interface TenantContext {
  userId: string;
  role: string;
}

/** CLS key under which the tenant context is stored. */
const TENANT_KEY = 'tenant';

/**
 * Thin wrapper over `ClsService` exposing the request-scoped tenant context
 * (TDA-003 §3). The `TenantContextInterceptor` calls {@link set} from `req.user`
 * after the auth guard runs; `PrismaService` (Task 2) reads {@link get} to
 * auto-scope tenant-owned queries.
 *
 * **Key invariant:** "no context" means system/background scope (unscoped), not
 * "deny" — cron/queue/engine code never sets a context and keeps full access.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService) {}

  /** The active tenant context, or `undefined` for system/background scope. */
  get(): TenantContext | undefined {
    return this.cls.get<TenantContext | undefined>(TENANT_KEY);
  }

  /** Set the tenant context for the remainder of the current CLS scope. */
  set(ctx: TenantContext): void {
    this.cls.set(TENANT_KEY, ctx);
  }

  /**
   * Run `fn` with the tenant context cleared (§5 explicit bypass), then restore
   * the previous value. Lets an authenticated admin action deliberately touch
   * data unscoped without leaking that bypass to the rest of the request.
   */
  runWithoutTenant<T>(fn: () => T): T {
    const previous = this.cls.get<TenantContext | undefined>(TENANT_KEY);
    this.cls.set(TENANT_KEY, undefined);
    try {
      return fn();
    } finally {
      this.cls.set(TENANT_KEY, previous);
    }
  }
}
