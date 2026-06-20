import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { SrpService } from './srp.service';
import { SrpStateService } from './srp-state.service';
import { CryptoModule } from '../crypto/crypto.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [CryptoModule, DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, SrpService, SrpStateService],
  exports: [AuthService],
})
export class AuthModule {}
