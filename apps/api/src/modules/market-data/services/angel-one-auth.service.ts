import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import SmartAPI from 'smartapi-javascript';
import { authenticator } from 'otplib';

@Injectable()
export class AngelOneAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(AngelOneAuthService.name);

  private smartApi: any;
  private jwtToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private feedToken: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;

  private readonly apiKey: string;
  private readonly clientId: string;
  private readonly password: string;
  private readonly totpSecret: string;

  private static readonly MAX_LOGIN_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 2000;
  /** Refresh 1 hour before expiry (tokens last ~24hrs) */
  private static readonly TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.getOrThrow<string>('ANGEL_ONE_API_KEY');
    this.clientId = this.configService.getOrThrow<string>('ANGEL_ONE_CLIENT_ID');
    this.password = this.configService.getOrThrow<string>('ANGEL_ONE_PASSWORD');
    this.totpSecret = this.configService.getOrThrow<string>('ANGEL_ONE_TOTP_SECRET');

    this.smartApi = new SmartAPI({ api_key: this.apiKey });
  }

  onModuleDestroy(): void {
    this.clearRefreshTimer();
  }

  /**
   * Authenticate with Angel One SmartAPI using TOTP-based login.
   * Retries up to 3 times on failure.
   */
  async login(): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= AngelOneAuthService.MAX_LOGIN_RETRIES; attempt++) {
      try {
        this.logger.log(`Login attempt ${attempt}/${AngelOneAuthService.MAX_LOGIN_RETRIES}`);

        const totp = authenticator.generate(this.totpSecret);
        const session = await this.smartApi.generateSession(
          this.clientId,
          this.password,
          totp,
        );

        if (!session?.data?.jwtToken) {
          throw new Error(
            `Invalid session response: ${JSON.stringify(session?.message ?? session)}`,
          );
        }

        this.jwtToken = session.data.jwtToken;
        this.refreshTokenValue = session.data.refreshToken;
        this.feedToken = session.data.feedToken;
        this.authenticated = true;

        // Tokens last ~24 hours
        this.tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        this.scheduleTokenRefresh();
        this.logger.log('Successfully authenticated with Angel One SmartAPI');
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Login attempt ${attempt} failed: ${lastError.message}`,
        );

        if (attempt < AngelOneAuthService.MAX_LOGIN_RETRIES) {
          await this.delay(AngelOneAuthService.RETRY_DELAY_MS * attempt);
        }
      }
    }

    this.authenticated = false;
    throw new Error(
      `Angel One login failed after ${AngelOneAuthService.MAX_LOGIN_RETRIES} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Refresh the JWT token using the stored refresh token.
   */
  async refreshToken(): Promise<void> {
    try {
      if (!this.refreshTokenValue) {
        this.logger.warn('No refresh token available, performing full login');
        await this.login();
        return;
      }

      this.logger.log('Refreshing Angel One auth token');
      const response = await this.smartApi.generateToken(this.refreshTokenValue);

      if (!response?.data?.jwtToken) {
        throw new Error(
          `Token refresh failed: ${JSON.stringify(response?.message ?? response)}`,
        );
      }

      this.jwtToken = response.data.jwtToken;
      this.refreshTokenValue = response.data.refreshToken ?? this.refreshTokenValue;
      this.feedToken = response.data.feedToken ?? this.feedToken;
      this.tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      this.authenticated = true;

      this.scheduleTokenRefresh();
      this.logger.log('Token refreshed successfully');
    } catch (error) {
      this.logger.error(
        `Token refresh failed: ${error instanceof Error ? error.message : error}`,
      );
      this.logger.log('Falling back to full re-login');
      await this.login();
    }
  }

  /**
   * Get the current JWT auth token.
   * Throws if not authenticated.
   */
  getAuthToken(): string {
    if (!this.jwtToken) {
      throw new Error('Not authenticated. Call login() first.');
    }
    return this.jwtToken;
  }

  /**
   * Get the feed token required for WebSocket connections.
   */
  getFeedToken(): string {
    if (!this.feedToken) {
      throw new Error('Not authenticated. Call login() first.');
    }
    return this.feedToken;
  }

  /**
   * Get the SmartAPI instance for making REST calls.
   */
  getSmartApi(): any {
    return this.smartApi;
  }

  /**
   * Get the client ID.
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Get the API key.
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Check whether the service is currently authenticated.
   */
  isAuthenticated(): boolean {
    if (!this.authenticated || !this.jwtToken) {
      return false;
    }
    if (this.tokenExpiresAt && new Date() >= this.tokenExpiresAt) {
      this.authenticated = false;
      return false;
    }
    return true;
  }

  /**
   * Logout and clear all stored tokens.
   */
  async logout(): Promise<void> {
    try {
      await this.smartApi.logout(this.clientId);
    } catch (error) {
      this.logger.warn(
        `Logout API call failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.clearSession();
    }
  }

  private clearSession(): void {
    this.jwtToken = null;
    this.refreshTokenValue = null;
    this.feedToken = null;
    this.tokenExpiresAt = null;
    this.authenticated = false;
    this.clearRefreshTimer();
  }

  private scheduleTokenRefresh(): void {
    this.clearRefreshTimer();

    if (!this.tokenExpiresAt) return;

    const refreshIn = Math.max(
      this.tokenExpiresAt.getTime() -
        Date.now() -
        AngelOneAuthService.TOKEN_REFRESH_BUFFER_MS,
      60_000, // minimum 1 minute
    );

    this.logger.log(
      `Token refresh scheduled in ${Math.round(refreshIn / 60_000)} minutes`,
    );

    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch((err) => {
        this.logger.error(`Scheduled token refresh failed: ${err.message}`);
      });
    }, refreshIn);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
