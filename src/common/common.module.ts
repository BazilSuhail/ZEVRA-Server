import { Module } from '@nestjs/common';
import { EnumsService } from '../shared/enums.service';
import { ExceptionsService } from '../shared/exceptions.service';

@Module({
  providers: [EnumsService, ExceptionsService],
  exports: [EnumsService, ExceptionsService],
})
export class CommonModule {}
