import { IsString, MinLength, MaxLength } from 'class-validator';

export class LoginFinishDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username!: string;

  @IsString()
  A!: string;

  @IsString()
  @MinLength(1)
  M1!: string;
}
