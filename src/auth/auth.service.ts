import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '../database/prisma.service';
import { CryptoService } from '../crypto/crypto.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private crypto: CryptoService,
    private jwt: JwtService,
  ) {}

  async register(username: string, email: string, password: string) {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing) {
      throw new ConflictException(
        existing.username === username ? 'Username already taken' : 'Email already registered',
      );
    }

    const passwordHash = await this.crypto.hashPassword(password);
    const srpSalt = this.crypto.generateSrpSalt();
    const srpVerifier = this.crypto.computeSrpVerifier(password, srpSalt);

    const user = await prisma.user.create({
      data: { username, email, passwordHash, srpSalt, srpVerifier },
      select: { id: true, username: true, email: true, createdAt: true },
    });

    this.logger.log(`User registered: ${user.username}`);
    return { user };
  }

  async loginStart(username: string) {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw new UnauthorizedException('User not found');

    const B = this.crypto.getRandomHex(32);
    return { userId: user.id, username: user.username, srpSalt: user.srpSalt, B };
  }

  async loginFinish(body: { username: string; A: string; M1: string }) {
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user) throw new UnauthorizedException('User not found');

    const tokens = await this.issueTokens(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), status: 'ONLINE' },
    });

    this.logger.log(`User logged in: ${user.username}`);
    return { user: { id: user.id, username: user.username, email: user.email }, ...tokens };
  }

  async validateUser(username: string, password: string) {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return null;

    const valid = await this.crypto.comparePassword(password, user.passwordHash);
    if (!valid) return null;

    return { id: user.id, username: user.username, email: user.email };
  }

  async loginLocal(user: { id: string; username: string; email: string }) {
    const tokens = await this.issueTokens(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), status: 'ONLINE' },
    });

    return { user, ...tokens };
  }

  async issueTokens(userId: string) {
    const payload = { sub: userId };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = this.crypto.getRandomHex(32);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: { token: refreshToken, userId, expiresAt },
    });

    return { accessToken, refreshToken };
  }

  async refreshTokens(refreshToken: string) {
    const record = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await prisma.refreshToken.delete({ where: { id: record.id } });
    return this.issueTokens(record.userId);
  }

  async getProfile(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, email: true, status: true,
        createdAt: true, lastLoginAt: true, keyVersion: true,
      },
    });
  }

  async logout(userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'OFFLINE' },
    });
    await prisma.refreshToken.deleteMany({ where: { userId } });
  }
}
