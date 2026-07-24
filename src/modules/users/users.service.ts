import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../../database/schema';
import { eq, and, ilike, ne } from 'drizzle-orm';

/** Escapes LIKE/ILIKE metacharacters so user input matches literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const publicUserColumns = {
  id: users.id,
  username: users.username,
  status: users.status,
  keyVersion: users.keyVersion,
  createdAt: users.createdAt,
};

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  /** Public profile of another user. Never includes email. */
  async findPublicById(id: string) {
    const [user] = await this.db
      .select({ ...publicUserColumns, lastLoginAt: users.lastLoginAt })
      .from(users)
      .where(and(eq(users.id, id), eq(users.isActive, true)));
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Updates the caller's own profile; returns the caller's own view. */
  async updateProfile(userId: string, username: string) {
    const [taken] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, username), ne(users.id, userId)))
      .limit(1);
    if (taken) throw new ConflictException('Username already taken');

    const [updated] = await this.db
      .update(users)
      .set({ username, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
        keyVersion: users.keyVersion,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      });
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }

  /** Username search (prefix/substring). Email is neither searched nor returned. */
  async search(query: string, currentUserId: string, limit = 20) {
    return this.db
      .select(publicUserColumns)
      .from(users)
      .where(
        and(
          ilike(users.username, `%${escapeLike(query)}%`),
          ne(users.id, currentUserId),
          eq(users.isActive, true),
        ),
      )
      .orderBy(users.username)
      .limit(limit);
  }
}
