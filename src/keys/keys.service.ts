import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, senderKeys, memberships } from '../database/schema';
import { eq, and, inArray } from 'drizzle-orm';

@Injectable()
export class KeysService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async uploadKeys(userId: string, params: {
    publicKey: string;
    encryptedPrivateKey: string;
    keySalt: string;
    publicKeySign: string;
    encryptedPrivateKeySign: string;
    keySaltSign: string;
    keyVersion: number;
    argon2Params?: Record<string, number>;
  }) {
    const [updated] = await this.db
      .update(users)
      .set({
        publicKey: params.publicKey,
        encryptedPrivateKey: params.encryptedPrivateKey,
        keySalt: params.keySalt,
        publicKeySign: params.publicKeySign,
        encryptedPrivateKeySign: params.encryptedPrivateKeySign,
        keySaltSign: params.keySaltSign,
        keyVersion: params.keyVersion,
        argon2Params: (params.argon2Params as any) ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        publicKey: users.publicKey,
        publicKeySign: users.publicKeySign,
        keyVersion: users.keyVersion,
      });

    return updated;
  }

  async getPublicKeys(userIds: string[]) {
    if (userIds.length === 0) return [];

    return this.db
      .select({
        id: users.id,
        username: users.username,
        publicKey: users.publicKey,
        publicKeySign: users.publicKeySign,
        keyVersion: users.keyVersion,
      })
      .from(users)
      .where(inArray(users.id, userIds));
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
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        publicKey: users.publicKey,
        keyVersion: users.keyVersion,
      });

    return updated;
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

    return { count: values.length, groupId, epoch };
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

  async getSenderKeysByGroup(groupId: string) {
    return this.db
      .select({
        id: senderKeys.id,
        groupId: senderKeys.groupId,
        epoch: senderKeys.epoch,
        receiverId: senderKeys.receiverId,
        ownerId: senderKeys.ownerId,
        encryptedKey: senderKeys.encryptedKey,
        keySignature: senderKeys.keySignature,
        createdAt: senderKeys.createdAt,
      })
      .from(senderKeys)
      .where(eq(senderKeys.groupId, groupId))
      .orderBy(senderKeys.epoch);
  }

  async deleteSenderKeysForGroup(groupId: string) {
    const deleted = await this.db
      .delete(senderKeys)
      .where(eq(senderKeys.groupId, groupId))
      .returning({ id: senderKeys.id });

    return { count: deleted.length };
  }
}
