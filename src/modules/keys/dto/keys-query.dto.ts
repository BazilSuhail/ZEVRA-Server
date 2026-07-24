import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class PublicKeysQueryDto {
  /** Accepts repeated `userIds=` params and/or comma-separated values. */
  @Transform(({ value }) => {
    const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const ids = raw
      .flatMap((v: unknown) => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
      .filter((v: unknown) => v !== '');
    return Array.from(new Set(ids));
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  userIds!: string[];
}

export class SenderKeysQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  epoch?: number;
}
