import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import * as Perfil from '../models/Profile.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Freno por IP: la clave por defecto se deriva del nombre y el telefono del
// cliente, asi que es adivinable. Esto encarece el intentarlo a ciegas.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' },
});

const MAX_INTENTOS = 8;
const BLOQUEO_MINUTOS = 15;

// Hash bcrypt real de una clave aleatoria que nadie conoce. Comparar contra el
// cuando el perfil no existe gasta el mismo tiempo que un intento legitimo
// (~370 ms), de modo que el tiempo de respuesta no delata que slugs existen.
const HASH_SEÑUELO = '$2a$12$VJYnZuUbwaQ7ERAsi3cqLO7vs9nkSkUGbriqFBA99Rv1e.xr7880.';

router.post('/login', loginLimiter, async (req, res) => {
  const { slug, password } = req.body || {};
  if (!slug || !password) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const perfil = Perfil.porSlugConClave(slug);

  const invalido = () => res.status(401).json({ error: 'Clave incorrecta' });
  if (!perfil) {
    await bcrypt.compare(String(password), HASH_SEÑUELO);
    return invalido();
  }

  if (perfil.locked_until && new Date(perfil.locked_until) > new Date()) {
    const minutos = Math.ceil((new Date(perfil.locked_until) - Date.now()) / 60000);
    return res
      .status(429)
      .json({ error: `Perfil bloqueado por ${minutos} minuto(s) tras varios intentos fallidos.` });
  }

  const correcta = await bcrypt.compare(String(password), perfil.password_hash);
  if (!correcta) {
    const intentos = perfil.failed_attempts + 1;
    if (intentos >= MAX_INTENTOS) {
      const hasta = new Date(Date.now() + BLOQUEO_MINUTOS * 60000).toISOString();
      Perfil.registrarIntentos(perfil.slug, { failedAttempts: 0, lockedUntil: hasta });
    } else {
      Perfil.registrarIntentos(perfil.slug, { failedAttempts: intentos });
    }
    return invalido();
  }

  Perfil.registrarIntentos(perfil.slug, { failedAttempts: 0, lockedUntil: null });

  const token = jwt.sign({ slug: perfil.slug }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, profile: Perfil.aPublico(perfil) });
});

/** Cambio de clave desde el panel. Obligatorio en el primer ingreso. */
router.post('/password', requireAuth, async (req, res, next) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'La nueva clave debe tener al menos 8 caracteres' });
  }

  try {
    const hash = await bcrypt.hash(String(newPassword), 12);
    const cambios = Perfil.guardarClave(req.auth.slug, hash, { mustChange: false });
    if (!cambios) return res.status(404).json({ error: 'Perfil no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
