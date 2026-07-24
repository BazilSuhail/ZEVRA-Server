import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { SocketError } from '../common/errors/socket-error';

function firstConstraint(errors: ValidationError[]): string | undefined {
  for (const err of errors) {
    const constraints = err.constraints ? Object.values(err.constraints) : [];
    if (constraints.length > 0) return constraints[0];
    const nested = err.children ? firstConstraint(err.children) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Validates a socket event payload against a class-validator DTO and
 * returns a whitelisted instance. Throws SocketError(VALIDATION_ERROR).
 */
export function validatePayload<T extends object>(cls: new () => T, data: unknown): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SocketError('VALIDATION_ERROR', 'Invalid payload');
  }
  const instance = plainToInstance(cls, data);
  const errors = validateSync(instance, { whitelist: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    throw new SocketError('VALIDATION_ERROR', firstConstraint(errors) ?? 'Invalid payload');
  }
  return instance;
}
