import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class DisplayService {
  private readonly logger = new Logger(DisplayService.name);

  displayServerConfig() {
    const config = {
      application: {
        name: process.env.NEXT_PUBLIC_APP_NAME || 'SecureChat',
        nodeEnv: process.env.NODE_ENV || 'development',
        url: process.env.VITE_SITE_URL || 'http://localhost:3000',
      },
      supabase: {
        url: process.env.SUPABASE_URL
          ? '✅ Connected'
          : '❌ Not configured',
        anonKey: process.env.SUPABASE_ANON_KEY
          ? '••••••••••••••••••••••••••••••••••••••••'
          : '❌ Not configured',
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
          ? '••••••••••••••••••••••••••••••••••••••••'
          : '❌ Not configured',
      },
      security: {
        argon2id: {
          memory: process.env.ARGON2ID_MEM || '65536',
          time: process.env.ARGON2ID_TIME || '3',
          parallelism: process.env.ARGON2ID_PARALLELISM || '4',
        },
        jwt: {
          expiresIn: process.env.JWT_EXPIRES_IN || '15m',
          refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
        },
      },
    };

    this.logger.log('Server Configuration Status', 'DisplayService');
    this.logger.log(`Application: ${config.application.name} (${config.application.nodeEnv})`, 'DisplayService');
    this.logger.log(`URL: ${config.application.url}`, 'DisplayService');
    this.logger.log(`Supabase: ${config.supabase.url}`, 'DisplayService');
    this.logger.log(
      `Argon2id: m=${config.security.argon2id.memory}, t=${config.security.argon2id.time}, p=${config.security.argon2id.parallelism}`,
      'DisplayService',
    );
    this.logger.log(
      `JWT: expiresIn=${config.security.jwt.expiresIn}, refresh=${config.security.jwt.refreshExpiresIn}`,
      'DisplayService',
    );

    return config;
  }

  displayQrCodeInfo(publicKey: string) {
    this.logger.log('QR Code for Key Verification', 'DisplayService');
    this.logger.log(
      `Public Key: ${publicKey.substring(0, 16)}...${publicKey.substring(-16)}`,
      'DisplayService',
    );
    this.logger.log('Scan this key on both client devices to verify E2EE', 'DisplayService');
    this.logger.log('Visual QR code generation would go here', 'DisplayService');
  }
}