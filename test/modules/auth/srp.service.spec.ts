import * as crypto from 'node:crypto';
import { SrpService } from '../../../src/modules/auth/srp.service';
import { escapeLike } from '../../../src/modules/users/users.service';
import { hashRefreshToken } from '../../../src/modules/auth/auth.service';

const N = BigInt(
  '0x' +
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
    '15728E5A8AACAA68FFFFFFFFFFFFFFFF',
);
const G = 2n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}
const pad = (n: bigint) => Buffer.from(n.toString(16).padStart(512, '0'), 'hex');
const H = (...b: Buffer[]) => {
  const h = crypto.createHash('sha256');
  b.forEach((x) => h.update(x));
  return h.digest();
};
const toBig = (b: Buffer) => BigInt('0x' + b.toString('hex'));

/** Client side of the protocol, mirroring the web/mobile implementation. */
function clientProof(password: string, salt: string, Bhex: string) {
  const B = BigInt('0x' + Bhex);
  const a = toBig(crypto.randomBytes(32));
  const A = modPow(G, a, N);
  const x = toBig(H(Buffer.from(salt + password)));
  const k = toBig(H(pad(N), pad(G)));
  const u = toBig(H(pad(A), pad(B)));
  const base = (((B - k * modPow(G, x, N)) % N) + N) % N;
  const S = modPow(base, a + u * x, N);
  const K = H(pad(S));
  const hN = H(pad(N));
  const hg = H(pad(G));
  const xor = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) xor[i] = hN[i] ^ hg[i];
  const M1 = H(xor, H(Buffer.from(salt, 'hex')), pad(A), pad(B), K).toString('hex');
  return { A, M1 };
}

describe('SrpService', () => {
  const srp = new SrpService();
  const salt = crypto.randomBytes(16).toString('hex');
  const password = 'correct horse battery staple';
  const v = srp.computeVerifier(toBig(H(Buffer.from(salt + password))));

  it('accepts a correct proof and rejects a wrong password', () => {
    const { B, b } = srp.generateServerEphemeral(v);
    const good = clientProof(password, salt, B.toString(16));
    expect(srp.verifyClientProof({ A: good.A, M1: good.M1, b, B, v, srpSalt: salt, username: 'alice' }).valid).toBe(true);

    const bad = clientProof('wrong password', salt, B.toString(16));
    expect(srp.verifyClientProof({ A: bad.A, M1: bad.M1, b, B, v, srpSalt: salt, username: 'alice' }).valid).toBe(false);
  });

  it('rejects malformed M1 without throwing', () => {
    const { B, b } = srp.generateServerEphemeral(v);
    expect(srp.verifyClientProof({ A: 5n, M1: 'zz', b, B, v, srpSalt: salt, username: 'alice' }).valid).toBe(false);
  });

  it('validates A', () => {
    expect(srp.parseClientEphemeral('')).toBeNull();
    expect(srp.parseClientEphemeral('xyz')).toBeNull();
    expect(srp.parseClientEphemeral('a'.repeat(1025))).toBeNull();
    expect(srp.parseClientEphemeral(N.toString(16))).toBeNull();
    expect(srp.parseClientEphemeral('0')).toBeNull();
    expect(srp.parseClientEphemeral('abc123')).toBe(0xabc123n);
  });

  it('produces deterministic, user-specific decoy salts', () => {
    const one = srp.decoyCredentials('ghost', 's'.repeat(32));
    const two = srp.decoyCredentials('ghost', 's'.repeat(32));
    const other = srp.decoyCredentials('ghost2', 's'.repeat(32));
    expect(one.srpSalt).toBe(two.srpSalt);
    expect(one.srpSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(other.srpSalt).not.toBe(one.srpSalt);
  });
});

describe('auth/users helpers', () => {
  it('hashes refresh tokens with sha256 hex (matches the SQL migration)', () => {
    expect(hashRefreshToken('abc')).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
