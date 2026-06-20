import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);

  // ─── Random Bytes ─────────────────────────────────────────────────────────

  randomBytes(len: number): Buffer {
    return crypto.randomBytes(len);
  }

  randomHex(len: number): string {
    return crypto.randomBytes(len).toString('hex');
  }

  bufToBase64(buf: Buffer): string {
    return buf.toString('base64');
  }

  base64ToBuf(b64: string): Buffer {
    return Buffer.from(b64, 'base64');
  }

  // ─── Argon2id KEK Derivation ──────────────────────────────────────────────

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

  // ─── Private Key Encryption/Decryption with KEK ───────────────────────────

  encryptWithKEK(privateKey: Buffer, kek: Buffer): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  decryptWithKEK(ciphertextB64: string, ivB64: string, tagB64: string, kek: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);
  }

  /**
   * Convenience: encrypt a private key and return a single storable string.
   * Format: base64(iv):base64(tag):base64(ciphertext)
   */
  sealPrivateKey(privateKey: Buffer, kek: Buffer): string {
    const { ciphertext, iv, tag } = this.encryptWithKEK(privateKey, kek);
    return `${iv}:${tag}:${ciphertext}`;
  }

  /**
   * Convenience: unseal a private key from the single-string format.
   */
  unsealPrivateKey(sealed: string, kek: Buffer): Buffer {
    const [iv, tag, ciphertext] = sealed.split(':');
    return this.decryptWithKEK(ciphertext, iv, tag, kek);
  }

  // ─── X25519 Key Exchange ──────────────────────────────────────────────────

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
    return crypto.diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
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

  // ─── AES-256-GCM (for message encryption) ────────────────────────────────

  aesEncrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  aesDecrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
