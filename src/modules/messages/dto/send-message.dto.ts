import {
  IsString,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
  MaxLength,
  IsUUID,
  IsNotEmpty,
  IsObject,
} from 'class-validator';

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  SYSTEM = 'SYSTEM',
}

/** Max UTF-8 bytes of `encryptedContent` (enforced in MessagesService → 413). */
export const MAX_ENCRYPTED_CONTENT_BYTES = 10 * 1024;
/** Max UTF-8 bytes of JSON-serialised `metadata` (enforced in MessagesService → 413). */
export const MAX_METADATA_BYTES = 64 * 1024;

export class SendMessageDto {
  @IsUUID()
  channelId!: string;

  @IsString()
  @IsNotEmpty()
  encryptedContent!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  contentIv!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  contentTag!: string;

  @IsString()
  @MaxLength(256)
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

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
