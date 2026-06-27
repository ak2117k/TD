import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RefreshToken } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

/** Access token TTL (short-lived, carried in memory by clients). */
const ACCESS_TTL = '15m';
/** Refresh token TTL: 30 days. */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessTokenPayload {
  sub: string;
  role: string;
  email: string;
}

/** Minimal user shape needed to mint tokens. */
export interface AuthUser {
  id: string;
  role: string;
  email: string;
}

/** Request context persisted on the refresh token row for auditing/forensics. */
export interface TokenContext {
  userAgent?: string;
  ip?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Issues stateless access JWTs and rotating, hashed refresh tokens with
 * family-based reuse detection.
 *
 * Refresh tokens are opaque random strings; only their sha256 hash is stored.
 * Each lineage shares a `familyId`; rotating consumes the presented token and
 * mints a successor in the same family. Presenting an already-revoked token is
 * treated as theft and revokes the entire family.
 *
 * Constructor takes a PrismaClient and a JwtService so the service is directly
 * instantiable in unit/integration tests; the NestJS module wiring (global
 * guard, JwtModule) is added in a later task.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
  ) {}

  private sha256(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private signAccess(user: AuthUser): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      email: user.email,
    };
    return this.jwt.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: ACCESS_TTL,
    });
  }

  /** Verify and decode an access token. Throws if invalid/expired. */
  verifyAccess(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, {
      secret: process.env.JWT_SECRET,
    });
  }

  /** Create + persist a new refresh token row, returning the opaque token. */
  private async createRefresh(
    userId: string,
    familyId: string,
    ctx: TokenContext,
  ): Promise<{ opaque: string; row: RefreshToken }> {
    const opaque = randomBytes(32).toString('base64url');
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.sha256(opaque),
        familyId,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
      },
    });
    return { opaque, row };
  }

  /**
   * Issue a fresh access + refresh pair, starting a NEW refresh-token family.
   * The caller receives the opaque refresh token; only its hash is stored.
   */
  async issuePair(user: AuthUser, ctx: TokenContext = {}): Promise<TokenPair> {
    const familyId = randomBytes(16).toString('hex');
    const { opaque } = await this.createRefresh(user.id, familyId, ctx);
    return { accessToken: this.signAccess(user), refreshToken: opaque };
  }

  /**
   * Rotate a presented refresh token.
   *
   * - unknown token            -> reject
   * - already revoked (reuse)  -> revoke the whole family, then reject (theft)
   * - expired                  -> reject
   * - otherwise                -> mint a successor in the SAME family, mark the
   *                               presented token revoked + replacedById, return
   *                               the new pair.
   */
  async rotate(refreshToken: string, ctx: TokenContext = {}): Promise<TokenPair> {
    const tokenHash = this.sha256(refreshToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt) {
      // Reuse of a rotated token => assume the lineage is compromised.
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: existing.userId },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { opaque, row } = await this.createRefresh(
      user.id,
      existing.familyId,
      ctx,
    );
    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedById: row.id },
    });

    return {
      accessToken: this.signAccess({
        id: user.id,
        role: user.role,
        email: user.email,
      }),
      refreshToken: opaque,
    };
  }

  /** Revoke every still-live refresh token in a family (logout / reuse). */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
