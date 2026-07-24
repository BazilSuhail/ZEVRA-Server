import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { USERNAME_PATTERN, USERNAME_PATTERN_MESSAGE } from '../../users/dto/username.rules';

export class LoginFinishDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(USERNAME_PATTERN, { message: USERNAME_PATTERN_MESSAGE })
  username!: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]{1,1024}$/, { message: 'A must be a hex string of at most 1024 characters' })
  A!: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'M1 must be a 64-character hex string' })
  M1!: string;
}
