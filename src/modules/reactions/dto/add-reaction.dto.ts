import { IsString, IsUUID, Length } from 'class-validator';

/** Shared by REST POST/DELETE /reactions and socket reaction:add / reaction:remove. */
export class ReactionDto {
  @IsUUID()
  channelId!: string;

  @IsUUID()
  messageId!: string;

  /** 1..16 UTF-16 code units (DB column is varchar(32)). */
  @IsString()
  @Length(1, 16)
  emoji!: string;
}

export class AddReactionDto extends ReactionDto {}
