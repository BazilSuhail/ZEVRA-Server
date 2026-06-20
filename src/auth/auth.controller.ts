import { Controller, Post, Body, Get, Request, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthException } from '../shared/exceptions';

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() body: { username: string; email: string; password: string }) {
    try {
      const result = await this.authService.register(
        body.username,
        body.email,
        body.password,
      );
      return {
        success: true,
        user: result.user,
        message: 'Registration started - verify SRP',
      };
    } catch (error) {
      const err = error as Error;
      throw new AuthException(err.message || 'Registration failed');
    }
  }

  @Post('login/start')
  async loginStart(@Body() body: { username: string }) {
    try {
      const result = await this.authService.loginStart(body.username);
      return {
        success: true,
        srpSalt: result.srpSalt,
        B: result.B,
        message: 'SRP start - compute M1 on client',
      };
    } catch (error) {
      const err = error as Error;
      throw new AuthException(err.message || 'Login start failed');
    }
  }

  @Post('login/finish')
  async loginFinish(@Body() body: {
    username: string;
    A: string;
    M1: string;
    password: string;
  }) {
    try {
      const result = await this.authService.loginFinish(body);
      return {
        success: true,
        user: result.user,
        accessToken: result.accessToken,
        message: 'SRP completed - authentication successful',
      };
    } catch (error) {
      const err = error as Error;
      throw new AuthException(err.message || 'Login failed');
    }
  }

  @UseGuards(LocalAuthGuard)
  @Post('login/local')
  async loginLocal(@Body() body: { username: string; password: string }) {
    const isValid = await this.authService.validateUser(
      body.username,
      body.password,
    );

    if (!isValid) {
      throw new AuthException('Invalid credentials');
    }

    return {
      success: true,
      message: 'Local auth successful',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: any) {
    return {
      success: true,
      user: req.user,
    };
  }
}