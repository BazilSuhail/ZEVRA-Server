import {
  Controller,
  Post,
  Body,
  Get,
  HttpCode,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginStartDto } from './dto/login-start.dto';
import { LoginFinishDto } from './dto/login-finish.dto';
import { RefreshDto } from './dto/refresh.dto';

const MINUTE = 60_000;

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'register', limit: 5, windowMs: MINUTE })
  @Post('register')
  async register(@Body() body: RegisterDto) {
    const result = await this.authService.register(
      body.username,
      body.email,
      body.password,
    );
    return { success: true, ...result };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'login-start', limit: 10, windowMs: MINUTE, byUsername: true })
  @Post('login/start')
  @HttpCode(200)
  async loginStart(@Body() body: LoginStartDto) {
    const result = await this.authService.loginStart(body.username);
    return { success: true, ...result };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'login-finish', limit: 10, windowMs: MINUTE, byUsername: true })
  @Post('login/finish')
  @HttpCode(200)
  async loginFinish(@Body() body: LoginFinishDto, @Request() req: { ip?: string }) {
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
  async getMe(@Request() req: { user: { id: string } }) {
    const profile = await this.authService.getProfile(req.user.id);
    return { success: true, user: profile };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(@Request() req: { user: { id: string } }) {
    await this.authService.logout(req.user.id);
    return { success: true, message: 'Logged out' };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'refresh', limit: 30, windowMs: MINUTE })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: RefreshDto) {
    const tokens = await this.authService.refreshTokens(body.refreshToken);
    return { success: true, ...tokens };
  }
}
