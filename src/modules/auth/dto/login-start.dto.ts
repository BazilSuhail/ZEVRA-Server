import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { USERNAME_PATTERN, USERNAME_PATTERN_MESSAGE } from '../../users/dto/username.rules';

export class LoginStartDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(USERNAME_PATTERN, { message: USERNAME_PATTERN_MESSAGE })
  username!: string;
}
