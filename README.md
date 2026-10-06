# Prueba técnica Full Stack — CommerceHub

Respuestas de la prueba y una implementación ejecutable del `POST /api/v1/orders`
(Node.js + TypeScript + Express + PostgreSQL).

| Qué | Dónde |
|-----|-------|
| Respuestas a las 7 secciones (Markdown) | [`docs/RESPUESTAS.md`](docs/RESPUESTAS.md) |
| Respuestas en PDF (con diagramas) | [`docs/Respuestas_Prueba_Fullstack.pdf`](docs/Respuestas_Prueba_Fullstack.pdf) |
| Ejercicio 3: creación de orden | [`src/createOrder.ts`](src/createOrder.ts), [`src/idempotency.ts`](src/idempotency.ts) |
| Ejercicio 1.1: endpoint corregido | [`src/listOrders.ts`](src/listOrders.ts) |
| Modelo de datos (pregunta 26) | [`db/migrations/001_init.sql`](db/migrations/001_init.sql) |
| Pruebas (concurrencia, idempotencia, errores) | [`tests/orders.test.ts`](tests/orders.test.ts) |

## Cómo ejecutarlo

Requisitos: Node 20+ y Docker.

```bash
npm install
docker compose up -d --wait   # PostgreSQL en el puerto 5433
npm test                      # aplica las migraciones y corre las 14 pruebas
npm run dev                   # API en http://localhost:3000 (migra al arrancar)
```

Datos de ejemplo opcionales: `db/seed.sql` (clientes `C-1001`, `C-1002`; SKU `SKU-001`, `SKU-050`, `SKU-LAST`).

### Probar a mano

```bash
curl -i -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer C-1001" \
  -H "Idempotency-Key: 8bd95f8b-1f4e-4c1c-9a44-2f1f0c5d7a11" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"C-1001","items":[{"sku":"SKU-001","quantity":2},{"sku":"SKU-050","quantity":1}]}'
```

Repetir exactamente la misma petición devuelve la misma respuesta (`201`) sin crear otra orden.

## Decisiones clave

- **Stock sin negativos:** `UPDATE inventory SET available = available - $q WHERE sku = $s AND available >= $q`.
  La comprobación y el descuento son una sola sentencia, así que dos compras de la última unidad
  no pueden pasar ambas. `CHECK (available >= 0)` es la red de seguridad final.
- **Sin deadlocks:** los SKU de cada orden se procesan siempre en el mismo orden.
- **Transacción corta:** `BEGIN` antes de reclamar la clave de idempotencia y `COMMIT` tras guardar
  la orden y la respuesta. No hay llamadas externas dentro de ella.
- **Idempotencia:** `INSERT ... ON CONFLICT DO NOTHING` sobre `(customer_id, key)` dentro de la
  misma transacción. Una petición simultánea con la misma clave espera y después repite la
  respuesta guardada. La misma clave con otro cuerpo da `422`.
- **Precios y totales** salen de la base de datos, nunca del cliente.
- **Errores:** formato único `{ error: { code, message, details, requestId } }` con
  `400`, `401`, `403`, `404`, `409`, `422` y `500`.

## Alcance y límites (declarados a propósito)

- La autenticación es **de demostración** (`Authorization: Bearer <customerId>`). En producción se
  verificaría un JWT firmado. Lo relevante es que el usuario nunca llega por query o body.
- **No está implementada** la integración con el proveedor de pagos, ni el webhook, ni el job que
  expira reservas. Están diseñados en `docs/RESPUESTAS.md` (preguntas 14, 17 y 27). La tabla
  `webhook_events` ya existe en el modelo.
- Un intento que falla (por ejemplo `409` por falta de stock) hace `ROLLBACK` y **no consume** la
  clave de idempotencia; el cliente puede reintentar con ella.
