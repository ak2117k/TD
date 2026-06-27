import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthController } from './controllers/auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './services/auth.service';
import { EmailService } from './services/email/email.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Authentication module (TDA-002).
 *
 * Wires the auth core endpoints, the Passport JWT strategy, and registers
 * {@link JwtAuthGuard} as a GLOBAL `APP_GUARD` — every route in the app is
 * protected by default and opts out via `@Public()`.
 *
 * `TokenService` is built via a factory because its constructor takes a raw
 * `PrismaClient` + `JwtService` (so it stays directly instantiable in tests);
 * `PrismaService` extends `PrismaClient` and satisfies that dependency.
 */
@Module({
  imports: [
    PrismaModule,
    PassportModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    JwtStrategy,
    // EmailService's constructor takes an OPTIONAL transport (an interface with
    // no DI token), so build it via a factory to let it self-select by env.
    { provide: EmailService, useFactory: () => new EmailService() },
    {
      provide: TokenService,
      useFactory: (prisma: PrismaService, jwt: JwtService) =>
        new TokenService(prisma, jwt),
      inject: [PrismaService, JwtService],
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
