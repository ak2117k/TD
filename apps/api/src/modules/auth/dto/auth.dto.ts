import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SignupDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'trader@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/** A 6-digit TOTP code (used by MFA activate/disable). */
export class MfaCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit string' })
  code!: string;
}

/** Completes the login MFA challenge: the short-lived mfaToken + a TOTP code. */
export class LoginMfaDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  mfaToken!: string;

  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit string' })
  code!: string;
}
