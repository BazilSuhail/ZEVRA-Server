import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ChannelsService } from './channels.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { CurrentUser } from '../../common/current-user.decorator';

const uuid = new ParseUUIDPipe();

@Controller('channels')
@UseGuards(AuthGuard('jwt'))
export class ChannelsController {
  constructor(private channelsService: ChannelsService) {}

  @Post()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateChannelDto) {
    const { channel, created } = await this.channelsService.create(
      userId,
      dto.participantIds,
      dto.type,
      dto.name,
    );
    return { ...channel, created };
  }

  @Get()
  getInbox(@CurrentUser('id') userId: string) {
    return this.channelsService.getInbox(userId);
  }

  @Post('mark-read')
  markRead(@CurrentUser('id') userId: string, @Body() dto: MarkReadDto) {
    return this.channelsService.markRead(userId, dto.channelId, dto.lastReadMessageId);
  }

  @Get(':channelId')
  getChannel(@CurrentUser('id') userId: string, @Param('channelId', uuid) channelId: string) {
    return this.channelsService.getChannel(channelId, userId);
  }

  @Post(':channelId/members')
  addMember(
    @CurrentUser('id') userId: string,
    @Param('channelId', uuid) channelId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.channelsService.addMember(channelId, userId, dto.userId, dto.role);
  }

  @Delete(':channelId/members/:targetUserId')
  removeMember(
    @CurrentUser('id') userId: string,
    @Param('channelId', uuid) channelId: string,
    @Param('targetUserId', uuid) targetUserId: string,
  ) {
    return this.channelsService.removeMember(channelId, userId, targetUserId);
  }

  @Post(':channelId/archive')
  archive(@CurrentUser('id') userId: string, @Param('channelId', uuid) channelId: string) {
    return this.channelsService.archive(channelId, userId);
  }

  @Get(':channelId/typing')
  getTypingUsers(@CurrentUser('id') userId: string, @Param('channelId', uuid) channelId: string) {
    return this.channelsService.getTypingUsers(channelId, userId);
  }

  @Get(':channelId/read-receipts')
  getReadReceipts(@CurrentUser('id') userId: string, @Param('channelId', uuid) channelId: string) {
    return this.channelsService.getReadReceipts(channelId, userId);
  }
}
