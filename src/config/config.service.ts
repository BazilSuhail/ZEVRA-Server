import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigModuleOptions } from '@nestjs/config';

@Injectable()
export class ConfigService implements OnModuleInit {
  private config: Record<string, string> = {};

  constructor() {
    // Load environment variables
    this.loadEnvVars();
  }

  private loadEnvVars() {
    const required = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'JWT_SECRET',
      'ARGON2ID_MEM',
      'ARGON2ID_TIME',
      'ARGON2ID_PARALLELISM',
    ];

    for (const key of required) {
      const value = process.env[key];
      if (!value) {
        throw new Error(`Missing required env var: ${key}`);
      }
      this.config[key] = value;
    }
  }

  onModuleInit() {
    // Additional initialization if needed
  }

  get argon2Mem(): number { return parseInt(this.config['ARGON2ID_MEM'] || '65536'); }
  get argon2Time(): number { return parseInt(this.config['ARGON2ID_TIME'] || '3'); }
  get argon2Parallelism(): number { return parseInt(this.config['ARGON2ID_PARALLELISM'] || '4'); }

  get jwtSecret(): string { return this.config['JWT_SECRET'] || 'default-secret-change-in-prod'; }
  get jwtExpiresIn(): string { return this.config['JWT_EXPIRES_IN'] || '15m'; }
  get jwtRefreshExpiresIn(): string { return this.config['JWT_REFRESH_EXPIRES_IN'] || '7d'; }

  get supabaseUrl(): string { return this.config['SUPABASE_URL'] || ''; }
  get supabaseAnonKey(): string { return this.config['SUPABASE_ANON_KEY'] || ''; }
  get supabaseServiceKey(): string { return this.config['SUPABASE_SERVICE_ROLE_KEY'] || ''; }
}