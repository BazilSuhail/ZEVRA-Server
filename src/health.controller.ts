import { Controller, Get, Head, HttpCode } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller()
export class HealthController {
  @Get()
  @Head()
  @HttpCode(200)
  root() {
    return { status: 'ok' };
  }

  @Get('health')
  @Head('health')
  @HttpCode(200)
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('favicon.ico')
  @HttpCode(204)
  favicon() {}
}
