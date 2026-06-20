import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    CommonModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}