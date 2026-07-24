import { IsUUID } from 'class-validator';

/** REST POST /channels/mark-read */
export class MarkReadDto {
  @IsUUID()
  channelId!: string;

  @IsUUID()
  lastReadMessageId!: string;
}

/** Socket `mark-read` */
export class MarkReadSocketDto {
  @IsUUID()
  channelId!: string;

  @IsUUID()
  messageId!: string;
}

/** Socket payloads that only carry a channel id (join/leave/typing). */
export class ChannelIdDto {
  @IsUUID()
  channelId!: string;
}
