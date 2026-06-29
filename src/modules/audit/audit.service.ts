import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditLog } from '../../database/schema';
import { desc, eq, and, sql, SQL } from 'drizzle-orm';

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

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
    if (params.from) conditions.push(sql`${auditLog.createdAt} >= ${params.from}`);
    if (params.to) conditions.push(sql`${auditLog.createdAt} <= ${params.to}`);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(params.limit ?? 100)
      .offset(params.offset ?? 0);
  }

  async getSecurityEvents(userId: string) {
    return this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          sql`${auditLog.action} IN ('LOGIN_FAILED', 'LOGIN', 'REGISTER', 'KEY_ROTATE', 'PASSWORD_CHANGE', 'LOGOUT')`,
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(50);
  }
}
