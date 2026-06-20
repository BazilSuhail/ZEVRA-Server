import { Controller, Post, Body, Get, UseGuards, Request } from '@nestjs/common';
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
      return result;
    } catch (error) {
      const err = error as Error;
      throw new AuthException(err.message || 'Registration failed');
    }
  }

  @Post('login')
  async login(@Body() body: { username: string; password: string }) {
    try {
      const result = await this.authService.login(body.username, body.password);
      return result;
    } catch (error) {
      const err = error as Error;
      throw new AuthException(err.message || 'Login failed');
    }
  }

  @Post('verify-srp')
  async verifySRP(@Body() body: { username: string; password: string }) {
    try {
      const user = await this.authService.validateUser(
        body.username,
        body.password,
      );
      if (!user) {
        throw new AuthException('SRP validation failed');
      }
      return {
        user,
        message: 'SRP validation successful',
      };
    } catch (error) {
      const err = error as Error;
      throw new AuthException(err.message || 'SRP validation failed');
    }
  }
}