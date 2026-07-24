import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

export function flattenValidationErrors(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const err of errors) {
    const path = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      for (const msg of Object.values(err.constraints)) {
        out.push(parent ? `${path}: ${msg}` : msg);
      }
    }
    if (err.children && err.children.length > 0) {
      out.push(...flattenValidationErrors(err.children, path));
    }
  }
  return out;
}

/**
 * Global validation pipe. Produces a BadRequestException whose body carries
 * `message` (first problem) and `details` (all problems) for the global filter.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: (errors: ValidationError[]) => {
      const details = flattenValidationErrors(errors);
      return new BadRequestException({
        message: details[0] ?? 'Validation failed',
        details,
      });
    },
  });
}
