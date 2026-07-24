import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { CurrentUser } from '../../common/current-user.decorator';

@Controller('messages')
@UseGuards(AuthGuard('jwt'))
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  /** Same pipeline as socket `send-message` (broadcast, cache, offline queue, unread). */
  @Post()
  send(@CurrentUser('id') userId: string, @Body() dto: SendMessageDto) {
    return this.messagesService.send({ userId, ...dto });
  }

  @Get('channel/:channelId')
  getMessages(
    @CurrentUser('id') userId: string,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Query() query: GetMessagesQueryDto,
  ) {
    return this.messagesService.getMessages(
      channelId,
      userId,
      query.limit ?? 50,
      query.cursor,
      query.mode,
    );
  }

  @Delete(':messageId')
  deleteMessage(
    @CurrentUser('id') userId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ) {
    return this.messagesService.deleteMessage(userId, messageId);
  }
}
