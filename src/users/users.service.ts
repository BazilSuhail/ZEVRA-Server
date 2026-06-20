import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { prisma } from '../database/prisma.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  async findById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, username: true, email: true, status: true,
        isActive: true, keyVersion: true, createdAt: true, lastLoginAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByUsername(username: string) {
    return prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true, email: true, status: true },
    });
  }

  async updateStatus(userId: string, status: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, status: true },
    });
  }

  async search(query: string, limit = 20) {
    return prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
        isActive: true,
      },
      select: { id: true, username: true, email: true, status: true },
      take: limit,
    });
  }
}
