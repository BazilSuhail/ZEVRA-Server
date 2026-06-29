import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';

/**
 * SRP-6a implementation using Node.js crypto and native BigInt.
 *
 * Uses RFC 5054 2048-bit MODP group (same as standard SRP-6a libraries).
 * Parameters: g=2, N = RFC5054 2048-bit prime.
 */

// RFC 5054 2048-bit MODP Group
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF';

const G = 2n;
const N = BigInt('0x' + N_HEX);

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base = ((base % modulus) + modulus) % modulus;
  while (exponent > 0n) {
    if (exponent % 2n === 1n) {
      result = (result * base) % modulus;
    }
    exponent = exponent >> 1n;
    base = (base * base) % modulus;
  }
  return result;
}

function bigintToBuffer(n: bigint): Buffer {
  const hex = n.toString(16).padStart(512, '0');
  return Buffer.from(hex, 'hex');
}

function bufferToBigInt(buf: Buffer): bigint {
  return BigInt('0x' + buf.toString('hex'));
}

function sha256(...args: Buffer[]): Buffer {
  const h = crypto.createHash('sha256');
  for (const arg of args) h.update(arg);
  return h.digest();
}

function hkdf(ikm: Buffer, info: Buffer, length = 32): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, length));
}

@Injectable()
export class SrpService {
  private readonly logger = new Logger(SrpService.name);

  /**
   * Compute SRP verifier from password + salt.
   * x = Argon2id(password, salt) -> v = g^x mod N
   * Note: The actual Argon2id derivation happens in AuthService using CryptoService.
   * This method receives the already-derived x value as a bigint.
   */
  computeVerifier(x: bigint): bigint {
    return modPow(G, x, N);
  }

  /**
   * Generate server ephemeral (B).
   * b = random, B = (k * v + g^b) mod N
   * Returns { B, b } — caller must store b for verification.
   */
  generateServerEphemeral(v: bigint): { B: bigint; b: bigint } {
    const b = bufferToBigInt(crypto.randomBytes(32));
    const k = sha256(bigintToBuffer(N), bigintToBuffer(G));
    const kInt = bufferToBigInt(k);
    const B = (kInt * v + modPow(G, b, N)) % N;
    return { B, b };
  }

  /**
   * Verify client proof M1 and compute server proof M2.
   *
   * Inputs from client: A (client public ephemeral), M1 (client proof)
   * Inputs from server state: b (server secret), B (server public), v (verifier)
   * Inputs from DB: srpSalt, username
   *
   * Returns { valid, M2, K } where K is the shared session key.
   */
  verifyClientProof(params: {
    A: bigint;
    M1: string;
    b: bigint;
    B: bigint;
    v: bigint;
    srpSalt: string;
    username: string;
  }): { valid: boolean; M2: string; K: Buffer } {
    const { A, M1, b, B, v, srpSalt, username } = params;

    // A must not be 0 mod N
    if (A % N === 0n) {
      return { valid: false, M2: '', K: Buffer.alloc(0) };
    }

    // u = H(A, B)
    const u = bufferToBigInt(sha256(bigintToBuffer(A), bigintToBuffer(B)));

    // S = (A * v^u)^b mod N
    const S = modPow(A * modPow(v, u, N), b, N);

    // K = H(S)
    const K = sha256(bigintToBuffer(S));

    // M1 = H(H(N) xor H(g), H(salt), A, B, K)
    const hN = sha256(bigintToBuffer(N));
    const hg = sha256(bigintToBuffer(G));
    const hSalt = sha256(Buffer.from(srpSalt, 'hex'));
    const hUser = sha256(Buffer.from(username, 'utf-8'));

    const xorHN_HG = Buffer.alloc(hN.length);
    for (let i = 0; i < hN.length; i++) {
      xorHN_HG[i] = hN[i] ^ hg[i];
    }

    const expectedM1 = sha256(xorHN_HG, hSalt, bigintToBuffer(A), bigintToBuffer(B), K);
    const valid = expectedM1.toString('hex') === M1;

    if (!valid) {
      return { valid: false, M2: '', K: Buffer.alloc(0) };
    }

    // M2 = H(A, M1, K)
    const M2 = sha256(
      bigintToBuffer(A),
      Buffer.from(M1, 'hex'),
      K,
    ).toString('hex');

    return { valid: true, M2, K };
  }
}
