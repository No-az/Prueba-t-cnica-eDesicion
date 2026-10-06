import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

export interface StoredResponse {
  code: number;
  body: unknown;
}

/** Hash estable del cuerpo: mismo contenido => mismo hash, sin importar el orden de los ítems. */
export function hashRequest(input: {
  customerId: string;
  items: { sku: string; quantity: number }[];
}): string {
  const items = [...input.items].sort((a, b) => a.sku.localeCompare(b.sku));
  return createHash('sha256')
    .update(JSON.stringify({ customerId: input.customerId, items }))
    .digest('hex');
}

/**
 * Reclama la clave dentro de la transacción de la orden.
 * - Si es nueva: la inserta como IN_PROGRESS y devuelve null (hay que procesar).
 * - Si ya existía y está COMPLETED con el mismo hash: devuelve la respuesta guardada.
 *
 * Dos peticiones simultáneas con la misma clave: el segundo INSERT espera en el índice único
 * hasta que la primera transacción termine. Si ésta hace COMMIT, el segundo ve la fila
 * COMPLETED y repite la respuesta; si hace ROLLBACK, el segundo la reclama y procesa.
 */
export async function claimKey(
  client: PoolClient,
  customerId: string,
  key: string,
  requestHash: string
): Promise<StoredResponse | null> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (key, customer_id, request_hash, status)
     VALUES ($1, $2, $3, 'IN_PROGRESS')
     ON CONFLICT (customer_id, key) DO NOTHING`,
    [key, customerId, requestHash]
  );
  if (inserted.rowCount === 1) return null;

  const { rows } = await client.query(
    `SELECT request_hash, status, response_code, response_body
       FROM idempotency_keys WHERE customer_id = $1 AND key = $2`,
    [customerId, key]
  );
  const row = rows[0];
  if (row.request_hash !== requestHash) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'La Idempotency-Key ya se usó con un cuerpo distinto.'
    );
  }
  if (row.status !== 'COMPLETED') {
    throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'La petición original sigue en curso.');
  }
  return { code: row.response_code, body: row.response_body };
}

export async function saveResponse(
  client: PoolClient,
  customerId: string,
  key: string,
  response: StoredResponse,
  orderId: string
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'COMPLETED', response_code = $3, response_body = $4, order_id = $5
      WHERE customer_id = $1 AND key = $2`,
    [customerId, key, response.code, JSON.stringify(response.body), orderId]
  );
}
