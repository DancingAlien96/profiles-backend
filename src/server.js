import 'dotenv/config';
import { createApp } from './app.js';
import { conectarDB, cerrarDB } from './db.js';
import { cargarConfig } from './config.js';
import { recuperarPendiente } from './lib/rebuild.js';

let config;
try {
  config = cargarConfig();
  conectarDB(config.rutaDB);
} catch (err) {
  if (err.message !== 'Configuracion invalida') {
    console.error('[api] no se pudo abrir la base de datos:', err.message);
  }
  process.exit(1);
}

const servidor = createApp().listen(config.port, config.host, () => {
  console.log(`[api] escuchando en ${config.host}:${config.port}`);
  recuperarPendiente();
});

servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[api] el puerto ${config.port} ya esta ocupado.\n` +
        '      Suele ser otra instancia corriendo. En el VPS:\n' +
        '        sudo systemctl status perfiles-api\n'
    );
  } else if (err.code === 'EACCES') {
    console.error(`\n[api] sin permiso para usar el puerto ${config.port}.\n`);
  } else {
    console.error('[api] error al abrir el puerto:', err.message);
  }
  process.exit(1);
});

// Cerrar la base al parar el servicio para que SQLite consolide el WAL.
for (const señal of ['SIGTERM', 'SIGINT']) {
  process.on(señal, () => {
    console.log(`[api] cerrando (${señal})`);
    servidor.close(() => {
      cerrarDB();
      process.exit(0);
    });
  });
}
