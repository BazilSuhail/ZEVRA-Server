import { IsString, IsOptional, IsEnum } from 'class-validator';

export enum MemberRole {
  MEMBER = 'MEMBER',
  ADMIN = 'ADMIN',
}

export class AddMemberDto {
  @IsString()
  userId!: string;

  @IsEnum(MemberRole)
  @IsOptional()
  role?: MemberRole;
}
