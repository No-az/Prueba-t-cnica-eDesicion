import { z } from 'zod';

export const createOrderSchema = z
  .object({
    customerId: z.string().min(1).max(50),
    items: z
      .array(
        z
          .object({
            sku: z.string().min(1).max(50),
            quantity: z.number().int().min(1).max(100),
          })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine((o) => new Set(o.items.map((i) => i.sku)).size === o.items.length, {
    message: 'No se permiten SKU repetidos',
    path: ['items'],
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const idempotencyKeySchema = z.string().uuid();

export const listOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().datetime().optional(),
});
