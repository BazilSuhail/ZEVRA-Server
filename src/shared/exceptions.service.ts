import { Injectable } from '@nestjs/common';
import { AuthException, ValidationException, NotFoundException, ConflictException } from './exceptions';

@Injectable()
export class ExceptionsService {
  auth(message: string = 'Authentication failed') {
    return new AuthException(message);
  }

  validation(message: string = 'Validation failed', errors: any[] = []) {
    return new ValidationException(message, errors);
  }

  notFound(resource: string = 'Resource') {
    return new NotFoundException(resource);
  }

  conflict(message: string = 'Conflict') {
    return new ConflictException(message);
  }
}