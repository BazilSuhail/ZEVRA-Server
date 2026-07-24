import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class SenderKeyItemDto {
  @IsUUID()
  receiverId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  encryptedKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  keySignature!: string;
}

export class UploadSenderKeyDto {
  @IsUUID()
  groupId!: string;

  @IsInt()
  @Min(0)
  epoch!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SenderKeyItemDto)
  items!: SenderKeyItemDto[];
}
