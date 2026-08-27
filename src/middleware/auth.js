import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

/** Exige un token valido y deja el slug del dueño en req.auth. */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta el token de sesion' });

  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesion invalida o vencida. Vuelve a ingresar tu clave.' });
  }
}

/** Impide que el dueño de un perfil edite el de otro. */
export function requireOwner(req, res, next) {
  if (req.auth?.slug !== req.params.slug) {
    return res.status(403).json({ error: 'No puedes editar este perfil' });
  }
  next();
}

// El panel de administracion vive en una pagina publica del sitio, asi que
// cualquiera puede intentar adivinar la clave. Con 32 caracteres aleatorios
// es inviable, pero el freno es barato y corta el ruido en los logs.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
});

function verificarAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Clave de administrador incorrecta' });
  }
  next();
}

/** Rutas de administracion: solo tu, con la ADMIN_KEY. */
export const requireAdmin = [adminLimiter, verificarAdmin];
