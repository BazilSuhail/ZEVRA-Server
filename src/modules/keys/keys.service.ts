import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, senderKeys } from '../../database/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    @InjectQueue('key-rotation') private keyRotationQueue: Queue,
  ) {}

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

    // Return keyed by userId
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

    return user;
  }

  async rotateKeys(userId: string, params: {
    newPublicKey: string;
    newEncryptedPrivateKey: string;
    newKeySalt: string;
    newPublicKeySign: string;
    newEncryptedPrivateKeySign: string;
    newKeySaltSign: string;
    newKeyVersion: number;
  }) {
    // Queue key rotation (background processing)
    this.keyRotationQueue.add('rotate', {
      userId,
      ...params,
    }).catch((err) => this.logger.warn(`Key rotation queue failed: ${err.message}`));

    return { success: true, message: 'Keys rotation queued' };
  }

  async uploadSenderKeys(ownerId: string, groupId: string, epoch: number, items: {
    receiverId: string;
    encryptedKey: string;
    keySignature: string;
  }[]) {
    const values = items.map((item) => ({
      ownerId,
      groupId,
      receiverId: item.receiverId,
      epoch,
      encryptedKey: item.encryptedKey,
      keySignature: item.keySignature,
    }));

    // Batch insert (upsert: delete old epoch for this group, then insert)
    if (values.length > 0) {
      await this.db
        .delete(senderKeys)
        .where(
          and(
            eq(senderKeys.groupId, groupId),
            eq(senderKeys.epoch, epoch),
          ),
        );

      await this.db.insert(senderKeys).values(values);
    }

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
