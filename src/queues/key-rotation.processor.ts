import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../database/schema';
import { eq } from 'drizzle-orm';

interface KeyRotationJob {
  userId: string;
  newPublicKey: string;
  newEncryptedPrivateKey: string;
  newKeySalt: string;
  newPublicKeySign: string;
  newEncryptedPrivateKeySign: string;
  newKeySaltSign: string;
  newKeyVersion: number;
}

@Processor('key-rotation')
export class KeyRotationProcessor extends WorkerHost {
  private readonly logger = new Logger(KeyRotationProcessor.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {
    super();
  }

  async process(job: Job<KeyRotationJob>) {
    const {
      userId,
      newPublicKey,
      newEncryptedPrivateKey,
      newKeySalt,
      newPublicKeySign,
      newEncryptedPrivateKeySign,
      newKeySaltSign,
      newKeyVersion,
    } = job.data;

    this.logger.log(`Rotating keys for user ${userId} → v${newKeyVersion}`);

    const [updated] = await this.db
      .update(users)
      .set({
        publicKey: newPublicKey,
        encryptedPrivateKey: newEncryptedPrivateKey,
        keySalt: newKeySalt,
        publicKeySign: newPublicKeySign,
        encryptedPrivateKeySign: newEncryptedPrivateKeySign,
        keySaltSign: newKeySaltSign,
        keyVersion: newKeyVersion,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id, keyVersion: users.keyVersion });

    this.logger.log(`Key rotation complete for user ${userId}: v${updated?.keyVersion}`);

    return { success: true, keyVersion: updated?.keyVersion };
  }
}
