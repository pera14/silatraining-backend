import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { type ApiErrorBody, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@sila/contracts';
import type { Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';
import { isConstraintViolation, isRecordNotFound } from '../prisma/prisma-errors';
import { DomainError } from './domain-error';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

/** Renders every error as the contract shape `{ code, message, details? }`. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof DomainError) {
      return this.make(exception.code, exception.message, exception.details);
    }
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as ZodError;
      const details = zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return this.make('VALIDATION_FAILED', ERROR_MESSAGES.VALIDATION_FAILED, details);
    }
    if (exception instanceof ThrottlerException) {
      return this.make('RATE_LIMITED');
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status];
      if (code) {
        const message =
          status === 404
            ? ERROR_MESSAGES.NOT_FOUND
            : (this.messageOf(exception) ?? ERROR_MESSAGES[code]);
        return this.make(code, message);
      }
      return {
        status,
        body: { code: 'INTERNAL', message: this.messageOf(exception) ?? ERROR_MESSAGES.INTERNAL },
      };
    }
    // Safety nets for constraint violations a service did not translate itself.
    if (isRecordNotFound(exception)) return this.make('NOT_FOUND');
    if (isConstraintViolation(exception, 'check')) return this.make('VALIDATION_FAILED');
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL },
    };
  }

  private make(code: ErrorCode, message = ERROR_MESSAGES[code], details?: unknown) {
    const body: ApiErrorBody =
      details === undefined ? { code, message } : { code, message, details };
    return { status: ERROR_STATUS[code], body };
  }

  private messageOf(e: HttpException): string | undefined {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object' && 'message' in r) {
      const m = r.message;
      if (typeof m === 'string') return m;
    }
    return undefined;
  }
}
