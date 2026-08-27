import 'dotenv/config';
import { createApp } from './app.js';
import { connectDB } from './db.js';
import { cargarConfig } from './config.js';

let config;
try {
  config = cargarConfig();
} catch {
  process.exit(1);
}

connectDB()
  .then(() =>
    createApp().listen(config.port, config.host, () =>
      console.log(`[api] escuchando en ${config.host}:${config.port}`)
    )
  )
  .catch((err) => {
    console.error('[api] no se pudo conectar a la base de datos:', err.message);
    process.exit(1);
  });
