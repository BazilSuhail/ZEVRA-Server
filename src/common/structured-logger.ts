import { LoggerService, Logger } from '@nestjs/common';

interface LogContext {
  requestId?: string;
  userId?: string;
  [key: string]: unknown;
}

export class StructuredLogger implements LoggerService {
  private logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  private formatMessage(message: string, context?: LogContext): string {
    if (!context) return message;
    const parts = [message];
    if (context.requestId) parts.push(`req=${context.requestId}`);
    if (context.userId) parts.push(`user=${context.userId}`);
    for (const [key, value] of Object.entries(context)) {
      if (key !== 'requestId' && key !== 'userId') parts.push(`${key}=${value}`);
    }
    return parts.join(' ');
  }

  log(message: string, context?: LogContext) {
    this.logger.log(this.formatMessage(message, context));
  }

  error(message: string, trace?: string, context?: LogContext) {
    this.logger.error(this.formatMessage(message, context), trace);
  }

  warn(message: string, context?: LogContext) {
    this.logger.warn(this.formatMessage(message, context));
  }

  debug(message: string, context?: LogContext) {
    this.logger.debug(this.formatMessage(message, context));
  }

  verbose(message: string, context?: LogContext) {
    this.logger.verbose(this.formatMessage(message, context));
  }
}
