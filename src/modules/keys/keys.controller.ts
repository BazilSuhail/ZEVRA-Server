import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { KeysService } from './keys.service';
import { UploadSenderKeyDto } from './dto/upload-sender-keys.dto';
import { RotateKeysDto } from './dto/rotate-keys.dto';
import { PublicKeysQueryDto, SenderKeysQueryDto } from './dto/keys-query.dto';
import { CurrentUser } from '../../common/current-user.decorator';

@Controller('keys')
@UseGuards(JwtAuthGuard)
export class KeysController {
  constructor(private keysService: KeysService) {}

  @Get('me')
  getMyKeys(@CurrentUser('id') userId: string) {
    return this.keysService.getMyKeys(userId);
  }

  @Post('rotate')
  @HttpCode(200)
  rotateKeys(@CurrentUser('id') userId: string, @Body() dto: RotateKeysDto) {
    return this.keysService.rotateKeys(userId, dto);
  }

  @Get('public')
  getPublicKeys(@Query() query: PublicKeysQueryDto) {
    return this.keysService.getPublicKeys(query.userIds);
  }

  @Post('sender-keys')
  uploadSenderKeys(@CurrentUser('id') userId: string, @Body() dto: UploadSenderKeyDto) {
    return this.keysService.uploadSenderKeys(userId, dto.groupId, dto.epoch, dto.items);
  }

  @Get('sender-keys/:groupId')
  getSenderKeys(
    @CurrentUser('id') userId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Query() query: SenderKeysQueryDto,
  ) {
    return this.keysService.getSenderKeys(groupId, userId, query.epoch);
  }
}
