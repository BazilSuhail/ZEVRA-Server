import { Injectable } from '@nestjs/common';
import { prisma } from './database/prisma.service';

@Injectable()
export class AppService {
  async getHealth() {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'connected', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'error', database: 'disconnected', timestamp: new Date().toISOString() };
    }
  }
}
