import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class LivekitTokenDto {
  @IsString()
  @Matches(/^(dm|group)-[0-9a-fA-F-]{36,73}$/, { message: 'roomName is invalid' })
  roomName!: string;

  /** Accepted for backwards compatibility and ignored: the authenticated username is always used. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  participantName?: string;
}
