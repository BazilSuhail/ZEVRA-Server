import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { SharedModule } from './shared/shared.module';
import { UsersModule } from './users/users.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';

import { AppService } from './app.service';
import { AppController } from './app.controller';

import { DisplayService } from './config/display';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    SharedModule,
    UsersModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'db.postgres.supabase.com',
      port: 5432,
      username: 'postgres',
      password: process.env.SUPABASE_ANON_KEY || 'postgres',
      database: 'postgres',
      synchronize: false,
      logging: true,
      ssl: {
        rejectUnauthorized: false,
      },
      entities: [__dirname + '/users/entities/*.entity{.ts,.js}'],
    }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN },
    }),
  ],
  controllers: [AppController],
  providers: [AppService, DisplayService],
})
export class AppModule {}