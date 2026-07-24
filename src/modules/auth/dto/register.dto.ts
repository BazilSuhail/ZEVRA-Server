import { IsString, MinLength, MaxLength, IsEmail, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { USERNAME_PATTERN, USERNAME_PATTERN_MESSAGE } from '../../users/dto/username.rules';

export class RegisterDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(USERNAME_PATTERN, { message: USERNAME_PATTERN_MESSAGE })
  username!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
