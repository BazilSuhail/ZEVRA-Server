import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);

  // ─── Random Bytes ─────────────────────────────────────────────────────────
  getRandomBytes(len: number): Buffer {
    return crypto.randomBytes(len);
  }

  getRandomHex(len: number): string {
    return crypto.randomBytes(len).toString('hex');
  }

  // ─── Password Hashing (bcrypt) ────────────────────────────────────────────
  async hashPassword(password: string, saltRounds = 12): Promise<string> {
    return bcrypt.hash(password, saltRounds);
  }

  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  // ─── SRP Helpers ──────────────────────────────────────────────────────────
  generateSrpSalt(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  computeSrpVerifier(password: string, salt: string): string {
    const x = crypto.createHash('sha256').update(salt + password).digest();
    const v = crypto.createHash('sha256').update(x).digest();
    return v.toString('hex');
  }

  computeSrpM1(username: string, salt: string, A: string, B: string): string {
    return crypto.createHash('sha256').update(username + salt + A + B).digest('hex');
  }

  // ─── X25519 Key Exchange (using Node crypto) ──────────────────────────────
  generateX25519KeyPair(): { publicKey: Buffer; privateKey: Buffer } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    // X25519 DER is 44 bytes: 12 header + 32 key
    return {
      publicKey: publicKey.subarray(publicKey.length - 32),
      privateKey: privateKey.subarray(privateKey.length - 32),
    };
  }

  x25519DH(theirPublicKey: Buffer, myPrivateKey: Buffer): Buffer {
    const privKeyObj = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b6570042204', 'hex'), myPrivateKey]),
      format: 'der',
      type: 'pkcs8',
    });
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), theirPublicKey]),
      format: 'der',
      type: 'spki',
    });
    const secret = crypto.diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
    return secret;
  }

  // ─── Ed25519 Signing ──────────────────────────────────────────────────────
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

  sign(message: Buffer, privateKey: Buffer): Buffer {
    const keyObj = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b6565042204', 'hex'), privateKey]),
      format: 'der',
      type: 'pkcs8',
    });
    return crypto.sign(null, message, keyObj);
  }

  verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean {
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6565032100', 'hex'), publicKey]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, keyObj, signature);
  }

  // ─── AES-256-GCM ─────────────────────────────────────────────────────────
  encrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
  }

  decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // ─── Key Derivation ──────────────────────────────────────────────────────
  deriveKey(password: string, salt: Buffer, length = 32): Buffer {
    return crypto.pbkdf2Sync(password, salt, 100000, length, 'sha512');
  }
}
