import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from '../../shared/guards/jwt.strategy';
import { SrpService } from './srp.service';
import { SrpStateService } from './srp-state.service';
import { CryptoModule } from '../../shared/crypto/crypto.module';
import { DatabaseModule } from '../../database/database.module';
import { RedisModule } from '../../redis/redis.module';

@Module({
  imports: [CryptoModule, DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, SrpService, SrpStateService],
  exports: [AuthService],
})
export class AuthModule {}
