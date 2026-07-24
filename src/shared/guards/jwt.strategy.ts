import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../../database/schema';
import { eq } from 'drizzle-orm';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  status: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(DB) private db: NodePgDatabase) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET as string,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: { sub?: string }): Promise<AuthenticatedUser | null> {
    if (!payload?.sub || typeof payload.sub !== 'string') return null;
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, payload.sub));
    if (!user || !user.isActive) return null;
    return { id: user.id, username: user.username, email: user.email, status: user.status };
  }
}
