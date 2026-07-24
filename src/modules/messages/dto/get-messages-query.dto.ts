import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const MESSAGE_PAGE_MODES = ['latest', 'before', 'since'] as const;
export type MessagePageMode = (typeof MESSAGE_PAGE_MODES)[number];

/** Query for REST `GET /messages/channel/:channelId`. cursor = sequence number. */
export class GetMessagesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  cursor?: number;

  @IsIn(MESSAGE_PAGE_MODES)
  @IsOptional()
  mode?: MessagePageMode;
}

/** Payload for socket `get-messages`. */
export class GetMessagesSocketDto extends GetMessagesQueryDto {
  @IsUUID()
  channelId!: string;
}
