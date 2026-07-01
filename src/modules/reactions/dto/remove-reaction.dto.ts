import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class RemoveReactionDto {
  @IsString()
  @IsNotEmpty()
  channelId!: string;

  @IsString()
  @IsNotEmpty()
  messageId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  emoji!: string;
}
