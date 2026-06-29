import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../../database/schema';
import { eq, and, ilike, or, ne } from 'drizzle-orm';

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async findById(id: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
        isActive: users.isActive,
        keyVersion: users.keyVersion,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, id));
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, data: { username?: string }) {
    const updates: Record<string, unknown> = {};
    if (data.username) updates.username = data.username;
    if (Object.keys(updates).length === 0) return this.findById(userId);
    const [updated] = await this.db
      .update(users)
      .set(updates)
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
    return updated;
  }

  async search(query: string, currentUserId?: string, limit = 20) {
    const conditions = [
      or(
        ilike(users.username, `%${query}%`),
        ilike(users.email, `%${query}%`),
      ),
    ];
    if (currentUserId) {
      conditions.push(ne(users.id, currentUserId));
    }
    return this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
        createdAt: users.createdAt,
        keyVersion: users.keyVersion,
      })
      .from(users)
      .where(and(...conditions))
      .limit(limit);
  }
}
