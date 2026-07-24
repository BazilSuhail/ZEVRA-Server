import { IsString, IsInt, Min, Matches, Max } from 'class-validator';

/** 32-byte public key, standard base64 (44 chars with padding). */
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
/** Sealed private key: iv:tag:ciphertext, each standard base64. */
const SEALED_KEY_RE = /^[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;
const SALT_RE = /^[A-Za-z0-9+/]{16,128}={0,2}$/;

export class RotateKeysDto {
  @IsString()
  @Matches(PUBLIC_KEY_RE, { message: 'newPublicKey must be a base64 32-byte key' })
  newPublicKey!: string;

  @IsString()
  @Matches(SEALED_KEY_RE, { message: 'newEncryptedPrivateKey must be iv:tag:ciphertext (base64)' })
  newEncryptedPrivateKey!: string;

  @IsString()
  @Matches(SALT_RE, { message: 'newKeySalt must be base64' })
  newKeySalt!: string;

  @IsString()
  @Matches(PUBLIC_KEY_RE, { message: 'newPublicKeySign must be a base64 32-byte key' })
  newPublicKeySign!: string;

  @IsString()
  @Matches(SEALED_KEY_RE, { message: 'newEncryptedPrivateKeySign must be iv:tag:ciphertext (base64)' })
  newEncryptedPrivateKeySign!: string;

  @IsString()
  @Matches(SALT_RE, { message: 'newKeySaltSign must be base64' })
  newKeySaltSign!: string;

  @IsInt()
  @Min(2)
  @Max(1_000_000)
  newKeyVersion!: number;
}
