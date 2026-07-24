import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CallsService } from './calls.service';
import { CallHistoryQueryDto, CallHistoryWithUserQueryDto } from './dto/calls-history-query.dto';

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsHistoryController {
  constructor(private callsService: CallsService) {}

  @Get('history')
  async getHistory(@Request() req: { user: { id: string } }, @Query() query: CallHistoryQueryDto) {
    const offset = (query.page - 1) * query.limit;
    const calls = await this.callsService.getCallHistory(req.user.id, query.limit, offset);
    return {
      calls,
      page: query.page,
      hasMore: calls.length === query.limit,
    };
  }

  @Get('history/:userId')
  async getHistoryWithUser(
    @Request() req: { user: { id: string } },
    @Param('userId', new ParseUUIDPipe()) otherUserId: string,
    @Query() query: CallHistoryWithUserQueryDto,
  ) {
    const calls = await this.callsService.getCallHistoryWithUser(req.user.id, otherUserId, query.limit);
    return { calls };
  }
}
