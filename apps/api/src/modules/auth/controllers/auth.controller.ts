import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser, Public } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators';
import {
  LoginDto,
  LoginMfaDto,
  MfaCodeDto,
  MfaDisableDto,
  RefreshDto,
  SignupDto,
  VerifyEmailDto,
} from '../dto';
import { AuthService } from '../services/auth.service';
import { MfaService } from '../services/mfa.service';
import { TokenContext } from '../services/token.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  private ctx(req: Request): TokenContext {
    return {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    };
  }

  @Public()
  @Post('signup')
  @ApiOperation({ summary: 'Register a new user and send a verification email' })
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an email address and activate the account' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate and receive an access + refresh pair' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.ctx(req));
  }

  @Public()
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete the login MFA challenge and receive tokens' })
  loginMfa(@Body() dto: LoginMfaDto, @Req() req: Request) {
    return this.auth.loginMfa(dto.mfaToken, dto.code, this.ctx(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token for a new pair' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, this.ctx(req));
  }

  @ApiBearerAuth()
  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start TOTP enrolment (returns otpauth URI + secret)' })
  mfaEnroll(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.enroll(user.userId);
  }

  @ApiBearerAuth()
  @Post('mfa/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a code to activate MFA' })
  async mfaActivate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaCodeDto,
  ) {
    await this.mfa.activate(user.userId, dto.code);
    return { message: 'MFA enabled.' };
  }

  @ApiBearerAuth()
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a code to disable MFA' })
  async mfaDisable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaDisableDto,
  ) {
    await this.mfa.disable(user.userId, dto.password, dto.code);
    return { message: 'MFA disabled.' };
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the caller refresh tokens' })
  logout(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logout(user.userId);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Current user profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.userId);
  }
}
