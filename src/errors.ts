export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const validationError = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);
export const notFound = (message: string, details?: unknown) =>
  new AppError(404, 'NOT_FOUND', message, details);
export const outOfStock = (sku: string, requested: number) =>
  new AppError(409, 'OUT_OF_STOCK', `No hay stock suficiente para ${sku}.`, [
    { sku, requested },
  ]);
