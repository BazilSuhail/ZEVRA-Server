import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditLog } from '../database/schema';
import { desc, eq, and, gte, lte, sql, SQL } from 'drizzle-orm';

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async log(params: {
    action: string;
    userId?: string;
    ipAddress?: string;
    details?: Record<string, unknown>;
  }) {
    await this.db.insert(auditLog).values({
      action: params.action,
      userId: params.userId ?? null,
      ipAddress: params.ipAddress ?? null,
      details: (params.details as any) ?? null,
    });
  }

  async getLogs(params: {
    userId?: string;
    action?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const conditions: SQL[] = [];
    if (params.userId) conditions.push(eq(auditLog.userId, params.userId));
    if (params.action) conditions.push(eq(auditLog.action, params.action));
    if (params.from) conditions.push(gte(auditLog.createdAt, params.from));
    if (params.to) conditions.push(lte(auditLog.createdAt, params.to));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const result = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(params.limit ?? 100)
      .offset(params.offset ?? 0);

    return result;
  }

  async getSecurityEvents(userId: string) {
    return this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          sql`${auditLog.action} IN ('LOGIN_FAILED', 'LOGIN_SUCCESS', 'REGISTER', 'KEY_ROTATE', 'PASSWORD_CHANGE', 'LOGOUT')`,
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(50);
  }

  async getFailedLogins(ipAddress: string, minutes = 15) {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return this.db
      .select({ count: sql<number>`count(*)` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'LOGIN_FAILED'),
          eq(auditLog.ipAddress, ipAddress),
          gte(auditLog.createdAt, since),
        ),
      );
  }
}
