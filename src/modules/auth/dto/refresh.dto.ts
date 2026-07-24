import { IsString, Matches } from 'class-validator';

export class RefreshDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/i, { message: 'refreshToken is malformed' })
  refreshToken!: string;
}
