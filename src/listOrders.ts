import { pool } from './db.js';

/** Ejercicio 1.1: una sola consulta, paginación por cursor, sin SELECT *, sin N+1. */
export async function listOrders(userId: string, limit: number, cursor?: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.status, o.total_cents AS "totalCents", o.created_at AS "createdAt",
            COALESCE(
              json_agg(json_build_object(
                'sku', oi.sku,
                'quantity', oi.quantity,
                'unitPriceCents', oi.unit_price_cents
              )) FILTER (WHERE oi.id IS NOT NULL), '[]'
            ) AS items
       FROM (
             SELECT id, status, total_cents, created_at
               FROM orders
              WHERE customer_id = $1
                AND ($2::timestamptz IS NULL OR created_at < $2)
              ORDER BY created_at DESC
              LIMIT $3
            ) o
       LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id, o.status, o.total_cents, o.created_at
      ORDER BY o.created_at DESC`,
    [userId, cursor ?? null, limit]
  );
  const last = rows[rows.length - 1];
  return {
    data: rows,
    nextCursor: rows.length === limit ? (last.createdAt as Date).toISOString() : null,
  };
}
