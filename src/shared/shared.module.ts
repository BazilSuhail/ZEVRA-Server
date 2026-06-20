import { Module } from '@nestjs/common';

import { EnumsService } from './enums.service';
import { ExceptionsService } from './exceptions.service';

@Module({
  providers: [EnumsService, ExceptionsService],
  exports: [EnumsService, ExceptionsService],
})
export class SharedModule {}