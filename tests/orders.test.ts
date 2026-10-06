import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const app = buildApp();
const auth: Record<string, string> = { Authorization: 'Bearer C-1001' };

const post = (body: unknown, key: string | null = randomUUID(), headers = auth) => {
  const r = request(app).post('/api/v1/orders').set(headers);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body as object);
};

const stock = async (sku: string) =>
  (await pool.query('SELECT available, reserved FROM inventory WHERE sku = $1', [sku])).rows[0];
const countOrders = async () =>
  Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count);

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE order_items, orders, idempotency_keys, inventory, customers RESTART IDENTITY CASCADE'
  );
  await pool.query(`INSERT INTO customers VALUES ('C-1001','Uno'),('C-1002','Dos'),('C-1003','Tres')`);
  await pool.query(
    `INSERT INTO inventory (sku, available, price_cents) VALUES
       ('SKU-001', 10, 1500), ('SKU-050', 5, 4990), ('SKU-LAST', 1, 999)`
  );
});

afterAll(async () => {
  await pool.end();
});

describe('validación de entrada', () => {
  it('rechaza cantidades inválidas, SKU repetidos y campos desconocidos con 400', async () => {
    for (const body of [
      { customerId: 'C-1001', items: [{ sku: 'SKU-001', quantity: 0 }] },
      { customerId: 'C-1001', items: [{ sku: 'SKU-001', quantity: 1.5 }] },
      { customerId: 'C-1001', items: [] },
      {
        customerId: 'C-1001',
        items: [
          { sku: 'SKU-001', quantity: 1 },
          { sku: 'SKU-001', quantity: 1 },
        ],
      },
      { customerId: 'C-1001', items: [{ sku: 'SKU-001', quantity: 1, price: 1 }] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.requestId).toBeTruthy();
    }
    expect(await countOrders()).toBe(0);
  });

  it('exige Idempotency-Key en formato UUID', async () => {
    const body = { customerId: 'C-1001', items: [{ sku: 'SKU-001', quantity: 1 }] };
    expect((await post(body, null)).status).toBe(400);
    expect((await post(body, 'no-es-uuid')).status).toBe(400);
  });

  it('401 sin autenticación y 403 si customerId no es el del usuario', async () => {
    const body = { customerId: 'C-1002', items: [{ sku: 'SKU-001', quantity: 1 }] };
    expect((await post(body, randomUUID(), {})).status).toBe(401);
    expect((await post(body)).status).toBe(403);
  });
});

describe('creación de orden', () => {
  it('crea la orden, descuenta el stock y calcula el total con precios de la BD', async () => {
    const res = await post({
      customerId: 'C-1001',
      items: [
        { sku: 'SKU-001', quantity: 2 },
        { sku: 'SKU-050', quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_PAYMENT');
    expect(res.body.totalCents).toBe(2 * 1500 + 4990);
    expect(res.headers.location).toBe(`/api/v1/orders/${res.body.orderId}`);
    expect(await stock('SKU-001')).toEqual({ available: 8, reserved: 2 });
    expect(await stock('SKU-050')).toEqual({ available: 4, reserved: 1 });
  });

  it('SKU inexistente => 404', async () => {
    const res = await post({ customerId: 'C-1001', items: [{ sku: 'NOPE', quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sin stock => 409 y ROLLBACK completo (no queda stock descontado a medias)', async () => {
    const res = await post({
      customerId: 'C-1001',
      items: [
        { sku: 'SKU-001', quantity: 2 }, // se reserva primero...
        { sku: 'SKU-050', quantity: 99 }, // ...y esta línea falla
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
    expect(await stock('SKU-001')).toEqual({ available: 10, reserved: 0 });
    expect(await countOrders()).toBe(0);
  });
});

describe('concurrencia', () => {
  it('varios clientes compran la última unidad a la vez: gana uno y el stock nunca es negativo', async () => {
    const buy = (customer: string) =>
      post({ customerId: customer, items: [{ sku: 'SKU-LAST', quantity: 1 }] }, randomUUID(), {
        Authorization: `Bearer ${customer}`,
      });

    const results = await Promise.all([buy('C-1001'), buy('C-1002'), buy('C-1003')]);
    const codes = results.map((r) => r.status).sort();

    expect(codes).toEqual([201, 409, 409]);
    expect(await stock('SKU-LAST')).toEqual({ available: 0, reserved: 1 });
    expect(await countOrders()).toBe(1);
  });

  it('compras simultáneas con SKU en distinto orden no producen deadlock', async () => {
    const forward = [
      { sku: 'SKU-001', quantity: 1 },
      { sku: 'SKU-050', quantity: 1 },
    ];
    const backward = [...forward].reverse();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post({ customerId: 'C-1001', items: i % 2 ? forward : backward })
      )
    );
    expect(results.filter((r) => r.status === 500)).toHaveLength(0);
    // SKU-050 tiene 5 unidades: exactamente 5 órdenes ganan
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect((await stock('SKU-050')).available).toBe(0);
  });
});

describe('idempotencia', () => {
  const body = { customerId: 'C-1001', items: [{ sku: 'SKU-001', quantity: 2 }] };

  it('la misma clave dos veces crea una sola orden y devuelve la misma respuesta', async () => {
    const key = randomUUID();
    const first = await post(body, key);
    const second = await post(body, key);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await countOrders()).toBe(1);
    expect(await stock('SKU-001')).toEqual({ available: 8, reserved: 2 });
  });

  it('la misma clave en paralelo crea una sola orden', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body, key)));
    expect(new Set(results.map((r) => r.body.orderId)).size).toBe(1);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await countOrders()).toBe(1);
    expect(await stock('SKU-001')).toEqual({ available: 8, reserved: 2 });
  });

  it('la misma clave con otro cuerpo => 422', async () => {
    const key = randomUUID();
    await post(body, key);
    const res = await post({ ...body, items: [{ sku: 'SKU-001', quantity: 3 }] }, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('un intento fallido no consume la clave: se puede reintentar con ella', async () => {
    const key = randomUUID();
    const tooMuch = { customerId: 'C-1001', items: [{ sku: 'SKU-LAST', quantity: 5 }] };
    expect((await post(tooMuch, key)).status).toBe(409);
    await pool.query(`UPDATE inventory SET available = 10 WHERE sku = 'SKU-LAST'`);
    expect((await post(tooMuch, key)).status).toBe(201);
  });
});

describe('GET /api/v1/orders', () => {
  it('solo devuelve las órdenes del usuario autenticado, paginadas por cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await post({ customerId: 'C-1001', items: [{ sku: 'SKU-001', quantity: 1 }] });
    }
    await post(
      { customerId: 'C-1002', items: [{ sku: 'SKU-001', quantity: 1 }] },
      randomUUID(),
      { Authorization: 'Bearer C-1002' }
    );

    const page1 = await request(app).get('/api/v1/orders?limit=2').set(auth);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0].items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/v1/orders?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set(auth);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('rechaza un limit fuera de rango con 400', async () => {
    const res = await request(app).get('/api/v1/orders?limit=100000').set(auth);
    expect(res.status).toBe(400);
  });
});
