import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { USERNAME_PATTERN, USERNAME_PATTERN_MESSAGE } from './username.rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SearchUsersQueryDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit: number = 20;
}

export class UpdateProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(USERNAME_PATTERN, { message: USERNAME_PATTERN_MESSAGE })
  username!: string;
}

export class OnlineUsersQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return parts.map((p: unknown) => (typeof p === 'string' ? p.trim() : p)).filter((p: unknown) => p !== '');
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids: string[] = [];
}
