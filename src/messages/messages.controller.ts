import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('messages')
@UseGuards(AuthGuard('jwt'))
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post()
  send(@CurrentUser('id') userId: string, @Body() dto: SendMessageDto) {
    return this.messagesService.send({ userId, ...dto });
  }

  @Get('channel/:channelId')
  getMessages(
    @CurrentUser('id') userId: string,
    @Param('channelId') channelId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.messagesService.getMessages(
      channelId,
      userId,
      limit ? parseInt(limit, 10) : 50,
      cursor,
    );
  }

  @Get('unread')
  getUnreadCounts(@CurrentUser('id') userId: string) {
    return this.messagesService.getUnreadCounts(userId);
  }

  @Post('channel/:channelId/read/:messageId')
  markRead(
    @CurrentUser('id') userId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messagesService.markRead(userId, channelId, messageId);
  }

  @Delete(':messageId')
  deleteMessage(
    @CurrentUser('id') userId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messagesService.deleteMessage(userId, messageId);
  }
}
