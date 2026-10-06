import { pool } from './db.js';
import { config } from './config.js';
import { notFound, outOfStock } from './errors.js';
import { claimKey, hashRequest, saveResponse, type StoredResponse } from './idempotency.js';
import type { CreateOrderInput } from './schemas.js';

/**
 * Crea una orden PENDING_PAYMENT y reserva el stock en UNA transacción corta.
 * No hace llamadas externas dentro de la transacción (el pago ocurre después, fuera).
 */
export async function createOrder(
  input: CreateOrderInput,
  idempotencyKey: string
): Promise<StoredResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // ← INICIO

    // 1) Idempotencia: si ya se procesó, repetimos la respuesta
    const replay = await claimKey(client, input.customerId, idempotencyKey, hashRequest(input));
    if (replay) {
      await client.query('COMMIT');
      return replay;
    }

    // 2) El cliente debe existir
    const customer = await client.query('SELECT 1 FROM customers WHERE id = $1', [
      input.customerId,
    ]);
    if (!customer.rowCount) throw notFound('Cliente inexistente.', [{ customerId: input.customerId }]);

    // 3) Reservar stock. SKU siempre en el mismo orden para evitar deadlocks entre transacciones.
    const items = [...input.items].sort((a, b) => a.sku.localeCompare(b.sku));
    const lines: { sku: string; quantity: number; unitPriceCents: number }[] = [];
    let total = 0;

    for (const it of items) {
      // Comprobar y descontar en UNA sentencia: la fila queda bloqueada hasta el COMMIT,
      // así dos compras de la última unidad no pueden pasar ambas.
      const r = await client.query(
        `UPDATE inventory
            SET available = available - $2, reserved = reserved + $2
          WHERE sku = $1 AND available >= $2
      RETURNING price_cents`,
        [it.sku, it.quantity]
      );
      if (r.rowCount === 0) {
        const exists = await client.query('SELECT 1 FROM inventory WHERE sku = $1', [it.sku]);
        throw exists.rowCount
          ? outOfStock(it.sku, it.quantity)
          : notFound(`SKU inexistente: ${it.sku}.`, [{ sku: it.sku }]);
      }
      const unitPriceCents: number = r.rows[0].price_cents; // el precio sale de la BD, no del cliente
      total += unitPriceCents * it.quantity;
      lines.push({ ...it, unitPriceCents });
    }

    // 4) Orden e ítems
    const order = await client.query(
      `INSERT INTO orders (customer_id, status, total_cents, expires_at)
       VALUES ($1, 'PENDING_PAYMENT', $2, now() + make_interval(mins => $3))
    RETURNING id`,
      [input.customerId, total, config.reservationMinutes]
    );
    const orderId: string = order.rows[0].id;
    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, sku, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [orderId, l.sku, l.quantity, l.unitPriceCents]
      );
    }

    // 5) Guardar la respuesta para futuros reintentos
    const response: StoredResponse = {
      code: 201,
      body: { orderId, status: 'PENDING_PAYMENT', totalCents: total, items: lines },
    };
    await saveResponse(client, input.customerId, idempotencyKey, response, orderId);

    await client.query('COMMIT'); // ← FIN
    return response;
  } catch (e) {
    await client.query('ROLLBACK'); // devuelve todo el stock reservado y deja libre la clave
    throw e;
  } finally {
    client.release();
  }
}
