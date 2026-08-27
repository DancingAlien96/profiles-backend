import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';

/** Construye la aplicacion. Separada del arranque para poder probarla. */
export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Nginx va delante: sin esto el rate limit veria una sola IP

  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, cb) {
        // Sin origin = curl, el build de Netlify, health checks. Se permite.
        // Sin CORS_ORIGINS configurado se permite todo (desarrollo local).
        if (!origin || !origins.length || origins.includes(origin)) return cb(null, true);
        cb(new Error(`Origen no autorizado: ${origin}`));
      },
    })
  );

  // El limite cubre la foto en base64 (200 KB crecen ~33% al codificar).
  app.use(express.json({ limit: '400kb' }));

  // Health check: lo usan el build del frontend y el monitoreo del VPS.
  app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/profiles', profileRoutes);

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno' });
  });

  return app;
}
