import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import invitationRoutes from './routes/invitations.js';
import webhookRoutes from './routes/webhooks.js';

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
        // Sin origin = curl, el frontend desde el servidor, health checks. Se
        // permite. Sin CORS_ORIGINS configurado se permite todo (local).
        if (!origin || !origins.length || origins.includes(origin)) return cb(null, true);
        cb(new Error(`Origen no autorizado: ${origin}`));
      },
    })
  );

  // Los webhooks van ANTES del parser de JSON y con el cuerpo sin tocar: la
  // firma se calcula sobre los bytes exactos que mando la pasarela. Si se
  // firmara el JSON vuelto a serializar, bastaria con que ordenara las claves
  // distinto para que ninguna firma cuadrara nunca.
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRoutes);

  // El limite cubre la foto en base64 (200 KB crecen ~33% al codificar).
  app.use(express.json({ limit: '400kb' }));

  // Health check: lo usan el frontend y el monitoreo del VPS.
  // Con la clave de administrador devuelve ademas que IP ve Express, para
  // poder comprobar desde fuera si Nginx esta pasando X-Forwarded-For.
  app.get('/api/health', (req, res) => {
    const respuesta = { ok: true, ts: Date.now() };

    if (process.env.ADMIN_KEY && req.get('x-admin-key') === process.env.ADMIN_KEY) {
      respuesta.diagnostico = {
        ipVista: req.ip,
        forwardedFor: req.get('x-forwarded-for') || null,
        protocolo: req.protocol,
        // Sin esto, una pasarela a medio configurar es un fallo mudo: el
        // servicio arranca, las tarjetas ya activas funcionan, y solo se
        // descubre cuando un cliente intenta darse de alta y no puede pagar.
        pasarela: {
          llaveSecreta: process.env.RECURRENTE_SECRET_KEY
            ? process.env.RECURRENTE_SECRET_KEY.startsWith('sk_test_')
              ? 'sandbox'
              : 'produccion'
            : 'FALTA',
          precio: process.env.RECURRENTE_PRICE_ID ? 'configurado' : 'FALTA',
          firmaWebhook: process.env.RECURRENTE_WEBHOOK_SECRET ? 'configurada' : 'FALTA',
          diasDeGracia: Number(process.env.DIAS_DE_GRACIA) || 7,
        },
        avisos:
          process.env.RESEND_API_KEY && process.env.EMAIL_AVISOS
            ? `a ${process.env.EMAIL_AVISOS}`
            : 'apagados',
        corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean).length || 'ninguno (se acepta cualquiera)',
      };
    }

    res.json(respuesta);
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/profiles', profileRoutes);
  app.use('/api/invitations', invitationRoutes);

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno' });
  });

  return app;
}
