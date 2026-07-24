import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum ChannelType {
  DIRECT = 'DIRECT',
  GROUP = 'GROUP',
}

export const MAX_CHANNEL_PARTICIPANTS = 50;

/** REST POST /channels and socket `create-or-join`. */
export class CreateChannelDto {
  @IsEnum(ChannelType)
  type!: ChannelType;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  @MaxLength(64)
  name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHANNEL_PARTICIPANTS)
  @IsUUID('all', { each: true })
  participantIds!: string[];
}
