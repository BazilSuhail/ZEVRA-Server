import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const logger = new Logger('PrismaService');

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma = new PrismaClient({ adapter });

prisma.$connect()
  .then(() => logger.log('Prisma connected'))
  .catch((err) => logger.error('Prisma connection failed', err));
