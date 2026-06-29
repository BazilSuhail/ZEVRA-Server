import { IsString, IsEnum, IsOptional, IsArray, ArrayMinSize, ArrayMaxSize, MaxLength } from 'class-validator';

export enum ChannelType {
  DIRECT = 'DIRECT',
  GROUP = 'GROUP',
}

export class CreateChannelDto {
  @IsEnum(ChannelType)
  type!: ChannelType;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  participantIds!: string[];
}
