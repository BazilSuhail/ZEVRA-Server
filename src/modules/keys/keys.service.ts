import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, senderKeys, memberships, auditLog } from '../../database/schema';
import { eq, and, inArray, isNull, lt } from 'drizzle-orm';

export interface RotateKeysParams {
  newPublicKey: string;
  newEncryptedPrivateKey: string;
  newKeySalt: string;
  newPublicKeySign: string;
  newEncryptedPrivateKeySign: string;
  newKeySaltSign: string;
  newKeyVersion: number;
}

export interface SenderKeyItem {
  receiverId: string;
  encryptedKey: string;
  keySignature: string;
}

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async getPublicKeys(userIds: string[]) {
    if (userIds.length === 0) return {};

    const rows = await this.db
      .select({
        id: users.id,
        publicKey: users.publicKey,
        publicKeySign: users.publicKeySign,
        keyVersion: users.keyVersion,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const result: Record<string, { publicKey: string; publicKeySign: string; keyVersion: number }> = {};
    for (const row of rows) {
      result[row.id] = {
        publicKey: row.publicKey,
        publicKeySign: row.publicKeySign,
        keyVersion: row.keyVersion,
      };
    }
    return result;
  }

  async getMyKeys(userId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        publicKey: users.publicKey,
        encryptedPrivateKey: users.encryptedPrivateKey,
        keySalt: users.keySalt,
        publicKeySign: users.publicKeySign,
        encryptedPrivateKeySign: users.encryptedPrivateKeySign,
        keySaltSign: users.keySaltSign,
        keyVersion: users.keyVersion,
        argon2Params: users.argon2Params,
      })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Applies a client-generated key rotation synchronously. The version
   * check is part of the UPDATE predicate, so concurrent rotations cannot
   * both succeed or move the version backwards.
   */
  async rotateKeys(userId: string, params: RotateKeysParams) {
    const [updated] = await this.db
      .update(users)
      .set({
        publicKey: params.newPublicKey,
        encryptedPrivateKey: params.newEncryptedPrivateKey,
        keySalt: params.newKeySalt,
        publicKeySign: params.newPublicKeySign,
        encryptedPrivateKeySign: params.newEncryptedPrivateKeySign,
        keySaltSign: params.newKeySaltSign,
        keyVersion: params.newKeyVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), lt(users.keyVersion, params.newKeyVersion)))
      .returning({ keyVersion: users.keyVersion });

    if (!updated) {
      const [current] = await this.db
        .select({ keyVersion: users.keyVersion })
        .from(users)
        .where(eq(users.id, userId));
      if (!current) throw new NotFoundException('User not found');
      throw new BadRequestException(
        `newKeyVersion must be greater than the current key version (${current.keyVersion})`,
      );
    }

    try {
      await this.db.insert(auditLog).values({
        action: 'KEY_ROTATE',
        userId,
        details: { newKeyVersion: updated.keyVersion },
      });
    } catch (err) {
      this.logger.warn(`Audit log failed for KEY_ROTATE: ${(err as Error).message}`);
    }

    return { success: true, keyVersion: updated.keyVersion };
  }

  async uploadSenderKeys(ownerId: string, groupId: string, epoch: number, items: SenderKeyItem[]) {
    const receiverIds = Array.from(new Set(items.map((i) => i.receiverId)));
    if (receiverIds.length !== items.length) {
      throw new BadRequestException('Duplicate receiverId in items');
    }

    // Owner and every receiver must be active members of the channel.
    const memberRows = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.channelId, groupId),
          inArray(memberships.userId, [ownerId, ...receiverIds]),
          isNull(memberships.leftAt),
        ),
      );
    const members = new Set(memberRows.map((r) => r.userId));
    if (!members.has(ownerId)) {
      throw new ForbiddenException('Not a member of this group');
    }
    const outsiders = receiverIds.filter((id) => !members.has(id));
    if (outsiders.length > 0) {
      throw new BadRequestException('All receivers must be members of this group');
    }

    const values = items.map((item) => ({
      ownerId,
      groupId,
      receiverId: item.receiverId,
      epoch,
      encryptedKey: item.encryptedKey,
      keySignature: item.keySignature,
    }));

    // Replace only this owner's keys for this epoch, atomically.
    await this.db.transaction(async (tx) => {
      await tx
        .delete(senderKeys)
        .where(
          and(
            eq(senderKeys.groupId, groupId),
            eq(senderKeys.epoch, epoch),
            eq(senderKeys.ownerId, ownerId),
          ),
        );
      await tx.insert(senderKeys).values(values);
    });

    return { success: true, message: 'Sender keys uploaded' };
  }

  async getSenderKeys(groupId: string, receiverId: string, epoch?: number) {
    const conditions = [
      eq(senderKeys.groupId, groupId),
      eq(senderKeys.receiverId, receiverId),
    ];

    if (epoch !== undefined) {
      conditions.push(eq(senderKeys.epoch, epoch));
    }

    return this.db
      .select({
        id: senderKeys.id,
        groupId: senderKeys.groupId,
        epoch: senderKeys.epoch,
        encryptedKey: senderKeys.encryptedKey,
        keySignature: senderKeys.keySignature,
        ownerId: senderKeys.ownerId,
        createdAt: senderKeys.createdAt,
      })
      .from(senderKeys)
      .where(and(...conditions))
      .orderBy(senderKeys.epoch);
  }
}
