import { Controller, Get, Put, Param, Query, Body, UseGuards, Request } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

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

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
