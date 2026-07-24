import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Matches, Max, MaxLength, Min } from 'class-validator';

export class AuditLogsQueryDto {
  @IsOptional()
  @MaxLength(64)
  @Matches(/^[A-Z_]+$/, { message: 'action must be an upper-case action name' })
  action?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset: number = 0;
}
