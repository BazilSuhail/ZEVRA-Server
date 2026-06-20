import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../database/schema';
import { eq, ilike, or } from 'drizzle-orm';

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

  async findByUsername(username: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(eq(users.username, username));
    return user ?? null;
  }

  async updateStatus(userId: string, status: string) {
    const [updated] = await this.db
      .update(users)
      .set({ status })
      .where(eq(users.id, userId))
      .returning({ id: users.id, status: users.status });
    return updated;
  }

  async search(query: string, limit = 20) {
    return this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(
        or(
          ilike(users.username, `%${query}%`),
          ilike(users.email, `%${query}%`),
        ),
      )
      .limit(limit);
  }
}
