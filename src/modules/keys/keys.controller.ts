import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { KeysService } from './keys.service';
import { UploadSenderKeyDto } from './dto/upload-sender-keys.dto';
import { RotateKeysDto } from './dto/rotate-keys.dto';
import { CurrentUser } from '../../common/current-user.decorator';

@Controller('keys')
@UseGuards(AuthGuard('jwt'))
export class KeysController {
  constructor(private keysService: KeysService) {}

  @Get('me')
  getMyKeys(@CurrentUser('id') userId: string) {
    return this.keysService.getMyKeys(userId);
  }

  @Post('rotate')
  rotateKeys(@CurrentUser('id') userId: string, @Body() dto: RotateKeysDto) {
    return this.keysService.rotateKeys(userId, dto);
  }

  @Get('public')
  getPublicKeys(@Query('userIds') userIds: string[]) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    return this.keysService.getPublicKeys(ids);
  }

  @Post('sender-keys')
  uploadSenderKeys(@CurrentUser('id') userId: string, @Body() dto: UploadSenderKeyDto) {
    return this.keysService.uploadSenderKeys(
      userId,
      dto.groupId,
      dto.epoch,
      dto.items,
    );
  }

  @Get('sender-keys/:groupId')
  getSenderKeys(
    @CurrentUser('id') userId: string,
    @Param('groupId') groupId: string,
    @Query('epoch') epoch?: string,
  ) {
    return this.keysService.getSenderKeys(
      groupId,
      userId,
      epoch ? parseInt(epoch, 10) : undefined,
    );
  }

}
