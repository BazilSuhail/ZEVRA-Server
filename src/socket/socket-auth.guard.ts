import { CanActivate, Injectable, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Socket } from 'socket.io';
import { DB } from '../database/database.module';
import { users } from '../database/schema';

export const SOCKET_JWT_VERIFY_OPTIONS = { algorithms: ['HS256' as const] };

export interface SocketUser {
  id: string;
  username: string;
  status: string;
}

export interface SocketData {
  user?: SocketUser;
  /** JWT `exp` (seconds since epoch) of the token used at handshake. */
  tokenExp?: number;
}

export function extractSocketToken(client: Socket): string | null {
  const auth = client.handshake?.auth;
  if (typeof auth?.token === 'string' && auth.token) return auth.token;
  const authHeader = client.handshake?.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

export function isTokenExpired(data: SocketData | undefined, nowMs = Date.now()): boolean {
  return typeof data?.tokenExp === 'number' && data.tokenExp * 1000 <= nowMs;
}

/**
 * Per-event guard. A socket authenticated at connection time passes as long
 * as its token has not expired; otherwise the handshake token is verified.
 */
@Injectable()
export class SocketAuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    @Inject(DB) private db: NodePgDatabase,
  ) {}

  async canActivate(context: any): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    const data = client.data as SocketData;

    if (data?.user) {
      if (!isTokenExpired(data)) return true;
      return this.reject(client, 'TOKEN_EXPIRED');
    }

    const token = extractSocketToken(client);
    if (!token) return this.reject(client, 'NO_TOKEN', 'No token provided');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; exp?: number }>(token, SOCKET_JWT_VERIFY_OPTIONS);
      const [user] = await this.db
        .select({ id: users.id, username: users.username, status: users.status })
        .from(users)
        .where(and(eq(users.id, payload.sub), eq(users.isActive, true)));

      if (!user) return this.reject(client, 'USER_NOT_FOUND', 'User not found');

      client.data.user = user;
      client.data.tokenExp = payload.exp;
      return true;
    } catch (err) {
      const code = (err as { name?: string })?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      return this.reject(client, code);
    }
  }

  private reject(client: Socket, code: string, message = code): false {
    client.emit('error', { code, message });
    client.disconnect(true);
    return false;
  }
}
