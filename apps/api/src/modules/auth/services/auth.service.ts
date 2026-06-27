import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LoginDto, SignupDto } from '../dto';
import { EmailService } from './email/email.service';
import { PasswordService } from './password.service';
import { TokenContext, TokenPair, TokenService } from './token.service';

/** Email-verification token lifetime: 24h. */
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Generic, non-enumerating signup response. The same message is returned whether
 * or not the email was already registered.
 */
const SIGNUP_MESSAGE =
  'If that email address is available, a verification link has been sent.';

interface SignupResult {
  message: string;
  /** Test-only seam (NODE_ENV=test): the raw email-verification token. */
  verificationToken?: string;
}

/**
 * Orchestrates the auth core flows: signup + email verification, password login,
 * refresh-token rotation, logout, and the `/me` profile. Token mechanics live in
 * {@link TokenService}; password hashing in {@link PasswordService}; delivery in
 * {@link EmailService}. Every flow writes an `AuditLog` row (hash chaining is
 * deferred to TDA-008, so `hash`/`prevHash` are written as empty strings).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly email: EmailService,
  ) {}

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async audit(
    action: string,
    userId: string | null,
    target?: string | null,
    meta?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          userId: userId ?? undefined,
          target: target ?? undefined,
          meta: meta ?? undefined,
          hash: '',
          prevHash: '',
        },
      });
    } catch (err) {
      // Auditing must never break the user-facing flow.
      this.logger.error(`Failed to write audit row ${action}`, err as Error);
    }
  }

  private verifyUrl(rawToken: string): string {
    const base = process.env.APP_BASE_URL ?? 'http://localhost:4000';
    return `${base.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
  }

  /**
   * Create a PENDING_VERIFICATION user, issue an email-verification token (only
   * the sha256 is stored), and email the opaque token as a link. Always returns
   * the same generic message — no user enumeration. If the email is already
   * registered, no second account/email is created.
   */
  async signup(dto: SignupDto): Promise<SignupResult> {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return { message: SIGNUP_MESSAGE };
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: dto.displayName ?? null,
        role: 'USER',
        status: 'PENDING_VERIFICATION',
      },
    });

    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        tokenHash: this.sha256(rawToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });

    await this.email.sendVerification(email, this.verifyUrl(rawToken));
    await this.audit('AUTH_SIGNUP', user.id, email);

    const result: SignupResult = { message: SIGNUP_MESSAGE };
    if (process.env.NODE_ENV === 'test') {
      result.verificationToken = rawToken;
    }
    return result;
  }

  /**
   * Validate an unexpired, unused EMAIL_VERIFY token: mark `emailVerifiedAt`,
   * flip status to ACTIVE, and consume the token.
   */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.sha256(token) },
    });
    if (
      !record ||
      record.type !== 'EMAIL_VERIFY' ||
      record.usedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired verification token');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: 'Email verified. You can now sign in.' };
  }

  /**
   * Password login. Generic failure (no "wrong password" vs "no user"
   * distinction). Requires an ACTIVE, email-verified account. MFA is wired in
   * Task 5; for now an MFA-enabled user still receives tokens.
   */
  async login(dto: LoginDto, ctx: TokenContext): Promise<TokenPair> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });

    const passwordOk =
      user && (await this.passwords.verify(user.passwordHash, dto.password));
    if (!user || !passwordOk) {
      await this.audit('AUTH_LOGIN_FAILED', user?.id ?? null, email);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      await this.audit('AUTH_LOGIN_FAILED', user.id, email, {
        reason: 'inactive_or_unverified',
      });
      throw new UnauthorizedException('Account is not active or not verified');
    }

    // TODO(TDA-002 Task 5): when user.mfaEnabled, return { mfaRequired, mfaToken }
    // instead of a token pair and complete the challenge in /auth/login/mfa.

    const pair = await this.tokens.issuePair(
      { id: user.id, role: user.role, email: user.email },
      ctx,
    );
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit('AUTH_LOGIN', user.id, email);
    return pair;
  }

  /**
   * Rotate a refresh token. Reuse of an already-rotated token is detected by
   * {@link TokenService.rotate} (revokes the whole family); we surface that as an
   * `AUTH_REFRESH_REUSE` audit event and a 401.
   */
  async refresh(refreshToken: string, ctx: TokenContext): Promise<TokenPair> {
    try {
      const pair = await this.tokens.rotate(refreshToken, ctx);
      const userId = this.safeUserIdFromAccess(pair.accessToken);
      await this.audit('AUTH_REFRESH', userId, null);
      return pair;
    } catch (err) {
      if (
        err instanceof UnauthorizedException &&
        /reuse/i.test(err.message)
      ) {
        // The presented (now-revoked) token row still exists; recover its owner
        // so the theft event is attributable.
        const row = await this.prisma.refreshToken.findUnique({
          where: { tokenHash: this.sha256(refreshToken) },
          select: { userId: true },
        });
        await this.audit('AUTH_REFRESH_REUSE', row?.userId ?? null, null);
      }
      throw err;
    }
  }

  private safeUserIdFromAccess(accessToken: string): string | null {
    try {
      return this.tokens.verifyAccess(accessToken).sub;
    } catch {
      return null;
    }
  }

  /** Revoke all of the caller's live refresh tokens (logout everywhere). */
  async logout(userId: string): Promise<{ message: string }> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit('AUTH_LOGOUT', userId, null);
    return { message: 'Logged out.' };
  }

  /** Current-user profile for `/auth/me`. */
  async me(userId: string): Promise<{
    id: string;
    email: string;
    role: string;
    status: string;
    mfaEnabled: boolean;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
    };
  }
}
