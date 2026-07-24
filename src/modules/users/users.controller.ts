import { Controller, Get, Put, Param, Query, Body, UseGuards, Request, ParseUUIDPipe } from '@nestjs/common';
import { UsersService } from './users.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { OnlineUsersQueryDto, SearchUsersQueryDto, UpdateProfileDto } from './dto/users.dto';

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private sessionService: RedisSessionService,
  ) {}

  @Put('me')
  updateMe(@Request() req: { user: { id: string } }, @Body() body: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.id, body.username);
  }

  @Get('search')
  search(@Request() req: { user: { id: string } }, @Query() query: SearchUsersQueryDto) {
    return this.usersService.search(query.q, req.user.id, query.limit);
  }

  @Get('online')
  async getOnline(@Query() query: OnlineUsersQueryDto) {
    const online = await this.sessionService.getOnlineUsers(query.ids);
    return { online: Array.from(online) };
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.findPublicById(id);
  }
}
