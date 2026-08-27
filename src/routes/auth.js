import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import Profile from '../models/Profile.js';
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

const MAX_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

router.post('/login', loginLimiter, async (req, res) => {
  const { slug, password } = req.body || {};
  if (!slug || !password) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const profile = await Profile.findOne({ slug: String(slug).toLowerCase() }).select(
    '+passwordHash +failedAttempts +lockedUntil'
  );

  // Respuesta identica exista o no el perfil, para no revelar cuales existen.
  const invalid = () => res.status(401).json({ error: 'Clave incorrecta' });
  if (!profile) {
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    return invalid();
  }

  if (profile.lockedUntil && profile.lockedUntil > new Date()) {
    const mins = Math.ceil((profile.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Perfil bloqueado por ${mins} minuto(s) tras varios intentos fallidos.` });
  }

  const ok = await bcrypt.compare(String(password), profile.passwordHash);
  if (!ok) {
    profile.failedAttempts = (profile.failedAttempts || 0) + 1;
    if (profile.failedAttempts >= MAX_ATTEMPTS) {
      profile.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
      profile.failedAttempts = 0;
    }
    await profile.save();
    return invalid();
  }

  profile.failedAttempts = 0;
  profile.lockedUntil = undefined;
  await profile.save();

  const token = jwt.sign({ slug: profile.slug }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, profile: profile.toPublic() });
});

/** Cambio de clave desde el panel. Obligatorio en el primer ingreso. */
router.post('/password', requireAuth, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'La nueva clave debe tener al menos 8 caracteres' });
  }

  const profile = await Profile.findOne({ slug: req.auth.slug }).select('+passwordHash');
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

  profile.passwordHash = await bcrypt.hash(String(newPassword), 12);
  profile.mustChangePassword = false;
  await profile.save();

  res.json({ ok: true });
});

export default router;
