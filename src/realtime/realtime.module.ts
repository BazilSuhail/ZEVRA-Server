import { Module } from '@nestjs/common';
import { SupabaseModule } from './supabase.module';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [SupabaseModule],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
