import { IsString, IsEnum, IsInt, IsOptional, Min, MaxLength } from 'class-validator';

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  SYSTEM = 'SYSTEM',
}

export class SendMessageDto {
  @IsString()
  channelId!: string;

  @IsString()
  encryptedContent!: string;

  @IsString()
  contentIv!: string;

  @IsString()
  contentTag!: string;

  @IsString()
  signature!: string;

  @IsInt()
  @Min(0)
  sequenceNumber!: number;

  @IsInt()
  @Min(0)
  senderKeyEpoch!: number;

  @IsEnum(MessageType)
  @IsOptional()
  messageType?: MessageType;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
