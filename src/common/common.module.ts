import { Module } from '@nestjs/common';
import { HttpExceptionFilter } from './exception.filter';

@Module({
  providers: [HttpExceptionFilter],
  exports: [HttpExceptionFilter],
})
export class CommonModule {}
