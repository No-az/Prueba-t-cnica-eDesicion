CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE customers (
  id   text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE inventory (
  sku         text PRIMARY KEY,
  available   integer NOT NULL CHECK (available >= 0),   -- red de seguridad final
  reserved    integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  price_cents integer NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL REFERENCES customers(id),
  status      text NOT NULL CHECK (status IN ('PENDING_PAYMENT','PAID','CANCELLED','EXPIRED')),
  total_cents bigint NOT NULL,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);

CREATE TABLE order_items (
  id               bigserial PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES orders(id),
  sku              text NOT NULL REFERENCES inventory(sku),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL                       -- precio congelado al comprar
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE idempotency_keys (
  key           text NOT NULL,
  customer_id   text NOT NULL,
  request_hash  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_code integer,
  response_body jsonb,
  order_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, key)
);

CREATE TABLE webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
