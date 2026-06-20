import { Controller, Get, Request } from '@nestjs/common';
import { DisplayService } from './config/display';

@Controller()
export class AppController {
  constructor(private displayService: DisplayService) {}

  @Get('config')
  getConfig() {
    return this.displayService.displayServerConfig();
  }

  @Get('qr')
  getQrCodeInfo(
    @Request() req: any,
  ) {
    // In a real app, get the public key from the user's session
    const samplePublicKey = 'xyz789abc123def456ghi789jk';
    return this.displayService.displayQrCodeInfo(samplePublicKey);
  }
}