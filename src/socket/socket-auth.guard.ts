import { CanActivate, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../database/schema';
import { eq } from 'drizzle-orm';
import { Socket } from 'socket.io';

export interface SocketUser {
  id: string;
  username: string;
  email: string;
  status: string;
}

@Injectable()
export class SocketAuthGuard implements CanActivate {
  private readonly logger = new Logger(SocketAuthGuard.name);

  constructor(
    private jwt: JwtService,
    @Inject(DB) private db: NodePgDatabase,
  ) {}

  async canActivate(context: any): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    const token = this.extractToken(client);

    if (!token) {
      client.emit('error', { code: 'NO_TOKEN', message: 'No token provided' });
      client.disconnect(true);
      return false;
    }

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);

      const [user] = await this.db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          status: users.status,
        })
        .from(users)
        .where(eq(users.id, payload.sub));

      if (!user) {
        client.emit('error', { code: 'USER_NOT_FOUND', message: 'User not found' });
        client.disconnect(true);
        return false;
      }

      client.data.user = user;
      return true;
    } catch (err) {
      const code = (err as any)?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      client.emit('error', { code, message: code });
      client.disconnect(true);
      return false;
    }
  }

  private extractToken(client: Socket): string | null {
    // 1. Check handshake.auth.token
    const auth = client.handshake?.auth;
    if (auth?.token) return auth.token;

    // 2. Check handshake.headers.authorization
    const headers = client.handshake?.headers;
    const authHeader = headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }
}
