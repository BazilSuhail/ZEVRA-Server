import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SharedModule } from '../shared/shared.module';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    SharedModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET!,
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN! },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}