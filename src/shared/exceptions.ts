import { HttpException, HttpStatus } from '@nestjs/common';

export class AuthException extends HttpException {
  constructor(message: string = 'Authentication failed', statusCode: number = HttpStatus.UNAUTHORIZED) {
    super(message, statusCode);
  }
}

export class ValidationException extends HttpException {
  constructor(message: string = 'Validation failed', errors?: any[]) {
    super(message, HttpStatus.BAD_REQUEST);
    if (errors) {
      this['errors'] = errors;
    }
  }
}

export class NotFoundException extends HttpException {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, HttpStatus.NOT_FOUND);
  }
}

export class ConflictException extends HttpException {
  constructor(message: string = 'Conflict') {
    super(message, HttpStatus.CONFLICT);
  }
}