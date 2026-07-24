import {
  getAccessTokenTtl,
  getCorsOrigins,
  getDbConnectionOptions,
  getDbSslConfig,
  validateEnv,
} from '../../src/common/config';

const VALID = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  REDIS_URL: 'redis://localhost:6379',
};

describe('validateEnv', () => {
  it('accepts a valid environment', () => {
    expect(() => validateEnv({ ...VALID } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('reports every missing or weak variable', () => {
    expect(() => validateEnv({ JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*REDIS_URL/,
    );
  });

  it('rejects wildcard CORS', () => {
    expect(() => validateEnv({ ...VALID, CORS_ORIGIN: '*' } as NodeJS.ProcessEnv)).toThrow(/CORS_ORIGIN/);
  });
});

describe('config helpers', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('parses a comma separated CORS list', () => {
    process.env.CORS_ORIGIN = 'https://a.example, https://b.example/ ,';
    expect(getCorsOrigins()).toEqual(['https://a.example', 'https://b.example']);
  });

  it('never returns * and has no defaults in production', () => {
    process.env.CORS_ORIGIN = '*';
    process.env.NODE_ENV = 'production';
    expect(getCorsOrigins()).toEqual([]);
  });

  it('verifies DB certificates by default in production', () => {
    process.env.DATABASE_URL = 'postgres://h/db?sslmode=require';
    process.env.NODE_ENV = 'production';
    delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
    expect(getDbSslConfig()).toEqual({ rejectUnauthorized: true });
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    expect(getDbSslConfig()).toEqual({ rejectUnauthorized: false });
  });

  it('strips sslmode from the URL so the explicit ssl option wins', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db?sslmode=require&application_name=zevra';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    const opts = getDbConnectionOptions();
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });
    expect(opts.connectionString).not.toMatch(/sslmode/);
    expect(opts.connectionString).toMatch(/application_name=zevra/);
  });

  it('disables TLS when not requested', () => {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    delete process.env.DB_SSL;
    expect(getDbSslConfig()).toBe(false);
  });

  it('parses JWT_ACCESS_TTL', () => {
    delete process.env.JWT_ACCESS_TTL;
    expect(getAccessTokenTtl()).toBe(900);
    process.env.JWT_ACCESS_TTL = '1h';
    expect(getAccessTokenTtl()).toBe(3600);
    process.env.JWT_ACCESS_TTL = '120';
    expect(getAccessTokenTtl()).toBe(120);
  });
});
