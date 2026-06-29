import { IsString, IsInt, Min } from 'class-validator';

export class RotateKeysDto {
  @IsString()
  password!: string;

  @IsString()
  newPublicKey!: string;

  @IsString()
  newEncryptedPrivateKey!: string;

  @IsString()
  newKeySalt!: string;

  @IsString()
  newPublicKeySign!: string;

  @IsString()
  newEncryptedPrivateKeySign!: string;

  @IsString()
  newKeySaltSign!: string;

  @IsInt()
  @Min(1)
  newKeyVersion!: number;
}
