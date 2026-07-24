import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = requestId;
    (req as any).requestId = requestId;
    res.setHeader?.('X-Request-Id', requestId);
    next();
  }
}
