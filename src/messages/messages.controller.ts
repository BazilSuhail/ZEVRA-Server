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
    let parsedLimit = limit ? parseInt(limit, 10) : 50;
    if (isNaN(parsedLimit) || parsedLimit < 1) parsedLimit = 1;
    if (parsedLimit > 100) parsedLimit = 100;

    return this.messagesService.getMessages(
      channelId,
      userId,
      parsedLimit,
      cursor,
    );
  }

  @Delete(':messageId')
  deleteMessage(
    @CurrentUser('id') userId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messagesService.deleteMessage(userId, messageId);
  }
}
