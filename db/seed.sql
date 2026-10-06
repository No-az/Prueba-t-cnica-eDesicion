INSERT INTO customers (id, name) VALUES ('C-1001', 'Cliente Uno'), ('C-1002', 'Cliente Dos')
ON CONFLICT DO NOTHING;

INSERT INTO inventory (sku, available, price_cents) VALUES
  ('SKU-001', 10, 1500),
  ('SKU-050', 5, 4990),
  ('SKU-LAST', 1, 999)
ON CONFLICT (sku) DO NOTHING;
