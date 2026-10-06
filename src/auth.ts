import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: { id: string };
  }
}

/**
 * Autenticación DE DEMOSTRACIÓN: `Authorization: Bearer <customerId>`.
 * En producción aquí se verifica un JWT firmado (firma, expiración, audiencia)
 * y el id sale de sus claims. Lo importante es que el usuario nunca viene de query/body.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return next(new AppError(401, 'UNAUTHORIZED', 'Falta autenticación.'));
  req.user = { id: match[1] };
  next();
}
