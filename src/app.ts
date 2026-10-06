import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { requireAuth } from './auth.js';
import { createOrder } from './createOrder.js';
import { AppError, validationError } from './errors.js';
import { listOrders } from './listOrders.js';
import { createOrderSchema, idempotencyKeySchema, listOrdersQuerySchema } from './schemas.js';

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.locals.requestId = req.header('x-request-id') ?? `req_${randomUUID()}`;
    res.setHeader('x-request-id', res.locals.requestId);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/v1/orders', requireAuth, async (req, res, next) => {
    try {
      const key = idempotencyKeySchema.safeParse(req.header('idempotency-key'));
      if (!key.success) {
        throw validationError('Idempotency-Key es obligatoria y debe ser un UUID.');
      }
      const input = createOrderSchema.parse(req.body);
      if (input.customerId !== req.user!.id) {
        throw new AppError(403, 'FORBIDDEN', 'No puede crear órdenes para otro cliente.');
      }
      const result = await createOrder(input, key.data);
      const body = result.body as { orderId: string };
      res.status(result.code).location(`/api/v1/orders/${body.orderId}`).json(result.body);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/v1/orders', requireAuth, async (req, res, next) => {
    try {
      const { limit, cursor } = listOrdersQuerySchema.parse(req.query);
      res.json(await listOrders(req.user!.id, limit, cursor));
    } catch (e) {
      next(e);
    }
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const requestId = res.locals.requestId;
    let status = 500;
    let payload: { code: string; message: string; details?: unknown } = {
      code: 'INTERNAL_ERROR',
      message: 'Error interno.',
    };
    if (err instanceof ZodError) {
      status = 400;
      payload = {
        code: 'VALIDATION_ERROR',
        message: 'Datos de entrada inválidos.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (err instanceof AppError) {
      status = err.status;
      payload = { code: err.code, message: err.message, details: err.details };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      payload = { code: 'VALIDATION_ERROR', message: 'JSON inválido.' };
    } else {
      console.error({ requestId, err }); // el detalle va al log, nunca al cliente
    }
    res.status(status).json({ error: { ...payload, requestId } });
  };
  app.use(errorHandler);

  return app;
}
