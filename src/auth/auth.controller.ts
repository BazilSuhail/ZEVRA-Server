import {
  Controller,
  Post,
  Body,
  Get,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginStartDto } from './dto/login-start.dto';
import { LoginFinishDto } from './dto/login-finish.dto';
import { RefreshDto } from './dto/refresh.dto';

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Throttle({ register: { limit: 10000, ttl: 60000 } })
  @Post('register')
  async register(@Body() body: RegisterDto) {
    const result = await this.authService.register(
      body.username,
      body.email,
      body.password,
    );
    return { success: true, ...result };
  }

  @Throttle({ auth: { limit: 10000, ttl: 60000 } })
  @Post('login/start')
  async loginStart(@Body() body: LoginStartDto) {
    const result = await this.authService.loginStart(body.username);
    return { success: true, ...result };
  }

  @Throttle({ auth: { limit: 10000, ttl: 60000 } })
  @Post('login/finish')
  async loginFinish(@Body() body: LoginFinishDto, @Request() req: any) {
    const result = await this.authService.loginFinish({
      username: body.username,
      A: body.A,
      M1: body.M1,
      ip: req.ip,
    });
    return { success: true, ...result };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: any) {
    const profile = await this.authService.getProfile(req.user.id);
    return { success: true, user: profile };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Request() req: any) {
    await this.authService.logout(req.user.id);
    return { success: true, message: 'Logged out' };
  }

  @Throttle({ auth: { limit: 10000, ttl: 60000 } })
  @Post('refresh')
  async refresh(@Body() body: RefreshDto) {
    const tokens = await this.authService.refreshTokens(body.refreshToken);
    return { success: true, ...tokens };
  }
}
