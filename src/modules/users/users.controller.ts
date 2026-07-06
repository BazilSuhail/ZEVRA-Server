import { Controller, Get, Put, Param, Query, Body, UseGuards, Request } from '@nestjs/common';
import { UsersService } from './users.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private sessionService: RedisSessionService,
  ) {}

  @Put('me')
  updateMe(@Request() req: any, @Body() body: { username?: string }) {
    return this.usersService.updateProfile(req.user.id, body);
  }

  @Get('search')
  search(
    @Request() req: any,
    @Query('q') query: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.search(query, req.user.id, limit ? parseInt(limit) : 20);
  }

  @Get('online')
  async getOnline(@Query('ids') ids: string) {
    const userIds = ids
      ? ids.split(',').filter((id) => id.trim().length > 0)
      : [];
    const online = await this.sessionService.getOnlineUsers(userIds);
    return { online: Array.from(online) };
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
