import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';

@Injectable()
export class CryptoService {
  randomBytes(len: number): Buffer {
    return crypto.randomBytes(len);
  }

  randomHex(len: number): string {
    return crypto.randomBytes(len).toString('hex');
  }

  async deriveKEK(password: string, salt: Buffer): Promise<Buffer> {
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
      hashLength: 32,
      raw: true,
      salt,
    });
    return Buffer.from(hash);
  }

  sealPrivateKey(privateKey: Buffer, kek: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  unsealPrivateKey(sealed: string, kek: Buffer): Buffer {
    const [iv, tag, ciphertext] = sealed.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
  }

  generateX25519KeyPair(): { publicKey: Buffer; privateKey: Buffer } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return {
      publicKey: publicKey.subarray(publicKey.length - 32),
      privateKey: privateKey.subarray(privateKey.length - 32),
    };
  }

  generateEd25519KeyPair(): { publicKey: Buffer; privateKey: Buffer } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return {
      publicKey: publicKey.subarray(publicKey.length - 32),
      privateKey: privateKey.subarray(privateKey.length - 32),
    };
  }

  verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean {
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, keyObj, signature);
  }
}
