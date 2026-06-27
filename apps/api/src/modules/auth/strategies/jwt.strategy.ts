import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators';
import { AccessTokenPayload } from '../services/token.service';

/**
 * Passport JWT strategy for the stateless access token.
 *
 * Validates `Authorization: Bearer <jwt>` against `JWT_SECRET` (HS256) and maps
 * the verified payload to the principal exposed as `req.user`. Passport itself
 * rejects missing/expired/forged tokens with 401 before `validate` runs.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET as string,
      algorithms: ['HS256'],
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    return { userId: payload.sub, role: payload.role, email: payload.email };
  }
}
