/**
 * TDA-003 Task 3 — RBAC via @Roles / @AdminOnly + RolesGuard.
 *
 * Bootstraps a focused Nest app that wires the REAL global guards in the same
 * order as AppModule: JwtAuthGuard first (authenticates → req.user), then
 * RolesGuard (authorises by role). No DB is needed — JwtStrategy verifies the
 * Bearer token purely from JWT_SECRET + audience, so we mint tokens with the
 * same claims TokenService.signAccess produces.
 *
 * A test controller exposes three routes:
 *   - GET /rbac-test/admin   — @AdminOnly()  (requires role ADMIN)
 *   - GET /rbac-test/plain   — authenticated, no @Roles (any role)
 *   - GET /rbac-test/public  — @Public()      (no auth at all)
 *
 * Run from apps/api:
 *   npx jest --config test/tda003/jest.config.js -v
 */

// JwtStrategy + token signing both read JWT_SECRET from the environment; set it
// before the strategy module is imported/instantiated.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda003';

import {
  Controller,
  Get,
  INestApplication,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { Public } from '../../src/common/decorators';
import { AdminOnly } from '../../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/modules/auth/guards/roles.guard';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';

@Controller('rbac-test')
class RbacTestController {
  @Get('admin')
  @AdminOnly()
  admin() {
    return { ok: 'admin' };
  }

  @Get('plain')
  plain() {
    return { ok: 'plain' };
  }

  @Get('public')
  @Public()
  pub() {
    return { ok: 'public' };
  }
}

// Mirror AppModule's guard wiring: JwtAuthGuard registered BEFORE RolesGuard so
// authentication (401 on no/invalid token) runs before authorisation (403).
@Module({
  imports: [PassportModule],
  controllers: [RbacTestController],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class RbacTestModule {}

describe('TDA-003 Task 3 — RolesGuard + @Roles/@AdminOnly (HTTP integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  // Mint an access token with exactly the claims JwtStrategy requires:
  // audience 'td-access' + { sub, role, email }.
  const jwt = new JwtService();
  const tokenFor = (role: 'USER' | 'ADMIN') =>
    jwt.sign(
      { sub: `user-${role}`, role, email: `${role.toLowerCase()}@test.local` },
      {
        secret: process.env.JWT_SECRET,
        algorithm: 'HS256',
        audience: 'td-access',
        expiresIn: '15m',
      },
    );

  const get = async (path: string, token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('USER token', () => {
    it('is forbidden (403) on the @AdminOnly route', async () => {
      expect(await get('/rbac-test/admin', tokenFor('USER'))).toBe(403);
    });
    it('is allowed (200) on a plain authenticated route', async () => {
      expect(await get('/rbac-test/plain', tokenFor('USER'))).toBe(200);
    });
  });

  describe('ADMIN token', () => {
    it('is allowed (200) on the @AdminOnly route', async () => {
      expect(await get('/rbac-test/admin', tokenFor('ADMIN'))).toBe(200);
    });
    it('is allowed (200) on a plain authenticated route', async () => {
      expect(await get('/rbac-test/plain', tokenFor('ADMIN'))).toBe(200);
    });
  });

  describe('no token', () => {
    it('is unauthorized (401) on the @AdminOnly route (JwtAuthGuard runs first)', async () => {
      expect(await get('/rbac-test/admin')).toBe(401);
    });
    it('is unauthorized (401) on a plain authenticated route', async () => {
      expect(await get('/rbac-test/plain')).toBe(401);
    });
    it('is allowed (200) on the @Public route', async () => {
      expect(await get('/rbac-test/public')).toBe(200);
    });
  });
});
