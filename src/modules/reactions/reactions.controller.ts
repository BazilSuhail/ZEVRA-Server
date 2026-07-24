import { Body, Controller, Delete, Get, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ReactionsService } from './reactions.service';
import type { ReactionActor } from './reactions.service';
import { AddReactionDto } from './dto/add-reaction.dto';
import { RemoveReactionDto } from './dto/remove-reaction.dto';
import { CurrentUser } from '../../common/current-user.decorator';

@Controller('reactions')
@UseGuards(AuthGuard('jwt'))
export class ReactionsController {
  constructor(private reactionsService: ReactionsService) {}

  @Post()
  addReaction(@CurrentUser() user: ReactionActor, @Body() dto: AddReactionDto) {
    return this.reactionsService.addReaction(
      { id: user.id, username: user.username },
      dto.channelId,
      dto.messageId,
      dto.emoji,
    );
  }

  @Delete()
  removeReaction(@CurrentUser() user: ReactionActor, @Body() dto: RemoveReactionDto) {
    return this.reactionsService.removeReaction(
      { id: user.id, username: user.username },
      dto.channelId,
      dto.messageId,
      dto.emoji,
    );
  }

  @Get()
  getReactions(
    @CurrentUser('id') userId: string,
    @Query('messageId', new ParseUUIDPipe()) messageId: string,
    @Query('channelId', new ParseUUIDPipe()) channelId: string,
  ) {
    return this.reactionsService.getReactions(messageId, userId, channelId);
  }
}
