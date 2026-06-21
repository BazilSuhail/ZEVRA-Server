import { IsString, IsInt, IsArray, IsUUID, Min } from 'class-validator';

export class UploadSenderKeyDto {
  @IsString()
  groupId!: string;

  @IsInt()
  @Min(0)
  epoch!: number;

  @IsArray()
  items!: {
    receiverId: string;
    encryptedKey: string;
    keySignature: string;
  }[];
}
