import { IsString, MinLength, MaxLength } from 'class-validator';

export class LoginStartDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username!: string;
}
