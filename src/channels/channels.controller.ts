import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ChannelsService } from './channels.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('channels')
@UseGuards(AuthGuard('jwt'))
export class ChannelsController {
  constructor(private channelsService: ChannelsService) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateChannelDto) {
    return this.channelsService.create(userId, dto.participantIds, dto.type, dto.name);
  }

  @Get()
  getInbox(@CurrentUser('id') userId: string) {
    return this.channelsService.getInbox(userId);
  }

  @Get(':channelId')
  getChannel(
    @CurrentUser('id') userId: string,
    @Param('channelId') channelId: string,
  ) {
    return this.channelsService.getChannel(channelId, userId);
  }

  @Post(':channelId/members')
  addMember(
    @CurrentUser('id') userId: string,
    @Param('channelId') channelId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.channelsService.addMember(channelId, userId, dto.userId, dto.role);
  }

  @Delete(':channelId/members/:targetUserId')
  removeMember(
    @CurrentUser('id') userId: string,
    @Param('channelId') channelId: string,
    @Param('targetUserId') targetUserId: string,
  ) {
    return this.channelsService.removeMember(channelId, userId, targetUserId);
  }

  @Post(':channelId/archive')
  archive(
    @CurrentUser('id') userId: string,
    @Param('channelId') channelId: string,
  ) {
    return this.channelsService.archive(channelId, userId);
  }

  @Post('mark-read')
  markRead(
    @CurrentUser('id') userId: string,
    @Body() body: { channelId: string; lastReadMessageId: string },
  ) {
    return this.channelsService.markRead(userId, body.channelId, body.lastReadMessageId);
  }
}
