import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../tenant/tenant-context.service';
import { TENANT_MODELS } from '../tenant/tenant.constants';

/** Operations whose `where` is a unique input (extendedWhereUnique applies). */
const UNIQUE_WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
]);

/** Operations whose `where` is a regular filter input (AND-merge applies). */
const FILTER_WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);

/**
 * Shared Prisma client (TDA-003 Task 2).
 *
 * Applies a `$extends` query component that makes tenant isolation
 * **structural**: for every tenant-owned model (see {@link TENANT_MODELS}),
 * whenever a non-admin tenant context is active, the query is auto-scoped to
 * `userId`. An unscoped query on user data therefore cannot be written by
 * accident.
 *
 * Bypass rule (spec §4/§5): scoping applies ONLY when a tenant context is active
 * AND `role !== 'ADMIN'`. No context (cron / Bull workers / the engine) or an
 * ADMIN context passes through unchanged — that is what keeps background and
 * admin cross-tenant work functioning.
 *
 * **Implementation note:** the installed Prisma 6 client (query-compiler build)
 * no longer ships the `$use` middleware the spec assumed, so scoping is done via
 * a `$extends` `query` component. A `query` component cannot swap one operation
 * for another (no `findUnique`→`findFirst` rewrite), so unique-where operations
 * are scoped with Prisma's `extendedWhereUnique` (GA since Prisma 5): the
 * `userId` filter is added to the unique `where`, so another tenant's row
 * returns `null` (findUnique) or throws `P2025` (update/delete) — never the row.
 * The constructor returns the extended client so the injected `PrismaService`
 * scopes transparently for existing callers.
 *
 * The extension **fails safe**: a tenant-model operation it cannot confidently
 * scope throws rather than running unscoped.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly tenantContext: TenantContextService) {
    super();

    const logger = this.logger;
    const extended = this.$extends(
      this.buildTenantScopingExtension(),
    ) as unknown as PrismaService;

    // The extended client has its own (non-PrismaService) prototype, so it lacks
    // our lifecycle method. Re-attach it so Nest's OnModuleInit still connects.
    extended.onModuleInit = async (): Promise<void> => {
      await extended.$connect();
      logger.log('Connected to PostgreSQL via Prisma (tenant scoping active)');
    };

    return extended;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Build the `$extends` `query` component that scopes tenant-owned models. The
   * tenant context is read at query time via the captured service (the
   * extension callback's `this` is not the PrismaService instance).
   */
  private buildTenantScopingExtension() {
    const tenantContext = this.tenantContext;
    return {
      query: {
        $allModels: {
          $allOperations({
            model,
            operation,
            args,
            query,
          }: {
            model: string;
            operation: string;
            args: unknown;
            query: (args: unknown) => Promise<unknown>;
          }): Promise<unknown> {
            const ctx = tenantContext.get();

            // System/background (no context) or ADMIN → never scope. Non-tenant
            // (global/IP) models → never scope.
            if (!ctx || ctx.role === 'ADMIN' || !TENANT_MODELS.has(model)) {
              return query(args);
            }

            return query(scopeArgs(model, operation, args, ctx.userId));
          },
        },
      },
    };
  }
}

type AnyRecord = Record<string, unknown>;

/** Auto-scope `args` for a tenant-owned operation, or fail safe by throwing. */
function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  userId: string,
): unknown {
  const base = (args as AnyRecord | undefined) ?? {};

  // Unique-where ops: add userId directly into the unique where
  // (extendedWhereUnique). A cross-tenant id then matches no row → null/P2025.
  if (UNIQUE_WHERE_OPS.has(operation)) {
    const where = (base.where as AnyRecord | undefined) ?? {};
    return { ...base, where: { ...where, userId } };
  }

  // Filter-where ops: merge AND: [{ userId }, <existing where> ].
  if (FILTER_WHERE_OPS.has(operation)) {
    return { ...base, where: { AND: [{ userId }, base.where ?? {}] } };
  }

  // create: stamp userId, overriding any client-supplied value.
  if (operation === 'create') {
    const data = (base.data as AnyRecord | undefined) ?? {};
    return { ...base, data: { ...data, userId } };
  }

  // createMany / createManyAndReturn: stamp userId on every row.
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const data = base.data;
    if (Array.isArray(data)) {
      return { ...base, data: data.map((row) => ({ ...(row as object), userId })) };
    }
    if (data && typeof data === 'object') {
      return { ...base, data: { ...(data as object), userId } };
    }
    throw new Error(
      `TenantScoping: ${operation} without data on tenant model '${model}' — ` +
        'refusing to run unscoped',
    );
  }

  // upsert: scope the unique lookup, stamp create, and freeze userId on update.
  if (operation === 'upsert') {
    const where = (base.where as AnyRecord | undefined) ?? {};
    const create = (base.create as AnyRecord | undefined) ?? {};
    const next: AnyRecord = {
      ...base,
      where: { ...where, userId },
      create: { ...create, userId },
    };
    if (next.update && typeof next.update === 'object') {
      const update = { ...(next.update as AnyRecord) };
      delete update.userId; // never let the update branch reassign ownership
      next.update = update;
    }
    return next;
  }

  // Fail safe: any other operation on a tenant model could read/write unscoped.
  throw new Error(
    `TenantScoping: unhandled operation '${operation}' on tenant model ` +
      `'${model}' — refusing to run unscoped`,
  );
}
