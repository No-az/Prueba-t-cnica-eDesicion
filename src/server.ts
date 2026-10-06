import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

await migrate();
const server = buildApp().listen(config.port, () =>
  console.log(`API escuchando en http://localhost:${config.port}`)
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
