import { IsString, IsInt, IsArray, ValidateNested, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UploadKeysDto {
  @IsString()
  publicKey!: string;

  @IsString()
  encryptedPrivateKey!: string;

  @IsString()
  keySalt!: string;

  @IsString()
  publicKeySign!: string;

  @IsString()
  encryptedPrivateKeySign!: string;

  @IsString()
  keySaltSign!: string;

  @IsInt()
  @Min(1)
  keyVersion!: number;

  @IsOptional()
  argon2Params?: Record<string, number>;
}
