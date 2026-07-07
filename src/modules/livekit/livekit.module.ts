import { Module } from '@nestjs/common';
import { LivekitService } from './livekit.service';
import { LivekitWebhookService } from './livekit.webhook';
import { LivekitController } from './livekit.controller';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [LivekitController],
  providers: [LivekitService, LivekitWebhookService],
  exports: [LivekitService],
})
export class LivekitModule {}
