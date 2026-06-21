import { Inject, Injectable, Logger } from '@nestjs/common';
import { SUPABASE } from './supabase.module';
import { SupabaseClient } from '@supabase/supabase-js';

export interface BroadcastMessage {
  event: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(@Inject(SUPABASE) private supabase: SupabaseClient) {}

  broadcastMessage(channelId: string, message: Record<string, unknown>) {
    const channel = this.supabase.channel(`channel:${channelId}`);
    channel.send({
      type: 'broadcast',
      event: 'message:new',
      payload: message,
    });
    this.logger.log(`Broadcast message to channel ${channelId}`);
  }

  broadcastTyping(channelId: string, userId: string, username: string, typing: boolean) {
    const channel = this.supabase.channel(`channel:${channelId}`);
    channel.send({
      type: 'broadcast',
      event: typing ? 'typing:start' : 'typing:stop',
      payload: { userId, username, channelId },
    });
  }

  broadcastReadReceipt(channelId: string, userId: string, messageId: string) {
    const channel = this.supabase.channel(`channel:${channelId}`);
    channel.send({
      type: 'broadcast',
      event: 'read:receipt',
      payload: { userId, messageId, channelId },
    });
  }

  broadcastPresence(channelId: string, userId: string, username: string, online: boolean) {
    const channel = this.supabase.channel(`channel:${channelId}`);
    channel.send({
      type: 'broadcast',
      event: online ? 'presence:join' : 'presence:leave',
      payload: { userId, username, channelId },
    });
  }
}
