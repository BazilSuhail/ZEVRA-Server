import { Controller, Post, Body, Get, Request, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() body: { username: string; email: string; password: string }) {
    const result = await this.authService.register(body.username, body.email, body.password);
    return { success: true, ...result };
  }

  @Post('login/start')
  async loginStart(@Body() body: { username: string }) {
    const result = await this.authService.loginStart(body.username);
    return { success: true, ...result };
  }

  @Post('login/finish')
  async loginFinish(@Body() body: { username: string; A: string; M1: string }) {
    const result = await this.authService.loginFinish(body);
    return { success: true, ...result };
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  async login(@Request() req: any) {
    const result = await this.authService.loginLocal(req.user);
    return { success: true, ...result };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: any) {
    const profile = await this.authService.getProfile(req.user.sub);
    return { success: true, user: profile };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Request() req: any) {
    await this.authService.logout(req.user.sub);
    return { success: true, message: 'Logged out' };
  }

  @Post('refresh')
  async refresh(@Body() body: { refreshToken: string }) {
    const tokens = await this.authService.refreshTokens(body.refreshToken);
    return { success: true, ...tokens };
  }
}
