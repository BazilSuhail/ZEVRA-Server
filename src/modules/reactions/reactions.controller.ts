import { Body, Controller, Delete, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ReactionsService } from './reactions.service';
import { AddReactionDto } from './dto/add-reaction.dto';
import { RemoveReactionDto } from './dto/remove-reaction.dto';
import { CurrentUser } from '../../common/current-user.decorator';

@Controller('reactions')
@UseGuards(AuthGuard('jwt'))
export class ReactionsController {
  constructor(private reactionsService: ReactionsService) {}

  @Post()
  addReaction(@CurrentUser('id') userId: string, @Body() dto: AddReactionDto) {
    return this.reactionsService.addReaction(userId, dto.channelId, dto.messageId, dto.emoji);
  }

  @Delete()
  removeReaction(@CurrentUser('id') userId: string, @Body() dto: RemoveReactionDto) {
    return this.reactionsService.removeReaction(userId, dto.channelId, dto.messageId, dto.emoji);
  }

  @Get()
  getReactions(
    @CurrentUser('id') userId: string,
    @Query('messageId') messageId: string,
    @Query('channelId') channelId: string,
  ) {
    return this.reactionsService.getReactions(messageId, userId, channelId);
  }
}
