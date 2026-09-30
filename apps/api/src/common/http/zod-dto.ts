import { endpoints, type EndpointKey } from '@sila/contracts';
import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';

type WithSchema<K extends EndpointKey, P extends 'body' | 'query' | 'params'> =
  (typeof endpoints)[K] extends Record<P, infer S extends z.ZodType> ? S : never;

/**
 * DTO classes generated straight from the contract registry, so controllers validate with exactly the
 * schemas the web app uses (global ZodValidationPipe):
 *
 *   class LoginDto extends bodyDto('auth.login') {}
 *   login(@Body() body: LoginDto) {}
 */
export function bodyDto<K extends EndpointKey>(key: K) {
  const schema = (endpoints[key] as { body?: z.ZodType }).body;
  if (!schema) throw new Error(`Endpoint ${key} has no body schema`);
  return createZodDto(schema as WithSchema<K, 'body'>);
}

export function queryDto<K extends EndpointKey>(key: K) {
  const schema = (endpoints[key] as { query?: z.ZodType }).query;
  if (!schema) throw new Error(`Endpoint ${key} has no query schema`);
  return createZodDto(schema as WithSchema<K, 'query'>);
}

export function paramsDto<K extends EndpointKey>(key: K) {
  const schema = (endpoints[key] as { params?: z.ZodType }).params;
  if (!schema) throw new Error(`Endpoint ${key} has no params schema`);
  return createZodDto(schema as WithSchema<K, 'params'>);
}
