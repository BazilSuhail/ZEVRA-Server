import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class LocalAuthGuard {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers['authorization'];

    // Simple local auth check - verify Bearer token exists
    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header missing or invalid');
    }

    // In a full implementation, we would verify the JWT here
    // For now, just proceed if Bearer token is present
    return true;
  }
}