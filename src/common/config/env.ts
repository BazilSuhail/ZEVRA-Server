const DEFAULT_DEV_ORIGINS = ['http://localhost:3001', 'http://localhost:8081', 'http://localhost:19006'];

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Validates required environment variables. Throws with a list of every
 * problem so the process fails fast at startup.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];

  if (!env.DATABASE_URL || env.DATABASE_URL.trim() === '') {
    problems.push('DATABASE_URL is required');
  }
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET is required and must be at least 32 characters');
  }
  if (!env.REDIS_URL || env.REDIS_URL.trim() === '') {
    problems.push('REDIS_URL is required');
  }
  if (env.PORT !== undefined && env.PORT !== '' && !/^\d+$/.test(env.PORT)) {
    problems.push('PORT must be a number');
  }
  if (env.JWT_ACCESS_TTL !== undefined && env.JWT_ACCESS_TTL !== '' && !/^\d+[smhd]?$/.test(env.JWT_ACCESS_TTL)) {
    problems.push('JWT_ACCESS_TTL must be seconds or a duration like 15m, 1h');
  }
  const origins = parseOrigins(env.CORS_ORIGIN);
  if (origins.includes('*')) {
    problems.push('CORS_ORIGIN must list explicit origins; "*" is not allowed with credentials');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
}

/**
 * Allowed CORS origins for both HTTP and Socket.IO. Parsed from the
 * comma-separated CORS_ORIGIN variable; falls back to local dev origins
 * outside production. Never returns '*'.
 */
export function getCorsOrigins(): string[] {
  const origins = parseOrigins(process.env.CORS_ORIGIN).filter((o) => o !== '*');
  if (origins.length > 0) return origins;
  return isProduction() ? [] : DEFAULT_DEV_ORIGINS;
}

/**
 * TLS options for the pg pool. TLS is enabled when DB_SSL=true or when the
 * connection string requests sslmode. Certificate verification is controlled
 * by DB_SSL_REJECT_UNAUTHORIZED (default true in production, false otherwise).
 */
export function getDbSslConfig(): false | { rejectUnauthorized: boolean } {
  const url = process.env.DATABASE_URL ?? '';
  const wantsSsl =
    process.env.DB_SSL === 'true' || /[?&]sslmode=(require|verify-ca|verify-full|prefer)/i.test(url);
  if (!wantsSsl) return false;
  const raw = process.env.DB_SSL_REJECT_UNAUTHORIZED;
  const rejectUnauthorized = raw === undefined || raw === '' ? isProduction() : raw === 'true';
  return { rejectUnauthorized };
}

/**
 * pg pool connection options. SSL query parameters are removed from the URL
 * because node-postgres lets them override the explicit `ssl` object, which
 * would silently ignore DB_SSL_REJECT_UNAUTHORIZED.
 */
export function getDbConnectionOptions(): {
  connectionString: string | undefined;
  ssl: false | { rejectUnauthorized: boolean };
} {
  const ssl = getDbSslConfig();
  const raw = process.env.DATABASE_URL;
  if (!raw || !ssl) return { connectionString: raw, ssl };
  try {
    const url = new URL(raw);
    for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
      url.searchParams.delete(key);
    }
    return { connectionString: url.toString(), ssl };
  } catch {
    return { connectionString: raw, ssl };
  }
}

/** Access token lifetime in seconds (JWT_ACCESS_TTL, default 15 minutes). */
export function getAccessTokenTtl(): number {
  const raw = process.env.JWT_ACCESS_TTL;
  if (!raw) return 15 * 60;
  const match = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (!match) return 15 * 60;
  const value = Number(match[1]);
  const unit = match[2] || 's';
  const multiplier = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return value * multiplier;
}
