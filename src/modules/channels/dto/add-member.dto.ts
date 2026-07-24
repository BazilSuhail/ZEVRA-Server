import { IsOptional, IsEnum, IsUUID } from 'class-validator';

export enum MemberRole {
  MEMBER = 'MEMBER',
  ADMIN = 'ADMIN',
}

export class AddMemberDto {
  @IsUUID()
  userId!: string;

  @IsEnum(MemberRole)
  @IsOptional()
  role?: MemberRole;
}
