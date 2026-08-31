import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import * as Perfil from '../models/Profile.js';
import * as Invitacion from '../models/Invitation.js';
import { requireAuth, requireOwner, requireAdmin } from '../middleware/auth.js';
import { obtenerDB } from '../db.js';

const router = Router();

// La foto llega ya comprimida por el navegador (400x400 WebP). Este limite
// es la red de seguridad por si alguien llama la API por fuera del panel.
const MAX_FOTO_BYTES = 200 * 1024;

/* ------------------------------------------------------- alta de clientes */

// Van antes de "/:slug" a proposito: en Express gana la primera que coincida,
// y "registro" es un slug sintacticamente valido.

/** Tope diario de guardados: un freno ante un abuso o un fallo en bucle. */
function errorDeCupo(cupo) {
  if (cupo.noExiste) return { error: 'Perfil no encontrado' };
  return {
    error:
      `Ya hiciste tus ${cupo.limite} cambios de hoy. Podrás seguir editando mañana; ` +
      'lo que guardaste hasta ahora se mantiene.',
    limite: cupo.limite,
    restantes: 0,
  };
}

const registroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera un rato e intenta de nuevo.' },
});

/** Lista para el panel de administracion: incluye los despublicados. */
router.get('/todos', requireAdmin, (_req, res) => {
  res.json(Perfil.listarTodos().map(Perfil.aPublico));
});

router.get('/disponible/:slug', (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();

  const apartado = (s) => Boolean(Invitacion.slugApartado(s));

  const motivo =
    Perfil.motivoSlugNoDisponible(slug) ||
    (apartado(slug) ? 'Ya esta apartada para otro cliente.' : null);

  if (!motivo) return res.json({ disponible: true });

  // Dos clientes que se llaman igual generan el mismo slug: se ofrece la
  // primera variante libre para que el segundo no se quede atascado.
  res.json({
    disponible: false,
    motivo,
    sugerencia: Perfil.sugerirSlug(slug, apartado),
  });
});

/** Alta desde el enlace de invitacion. La invitacion se gasta al usarse. */
router.post('/registro', registroLimiter, async (req, res, next) => {
  const { token, slug, name, role, tagline, footer, theme, links, hours, services, password } = req.body || {};

  const revision = Invitacion.revisar(token);
  if (!revision.ok) return res.status(410).json({ error: revision.motivo });

  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'La clave debe tener al menos 8 caracteres' });
  }

  // Si la invitacion trae direccion fijada, manda esa y se ignora lo que envie
  // el cliente: la tarjeta NFC y el QR ya estan impresos con ella.
  const slugLimpio = revision.invitacion.slug || String(slug || '').toLowerCase();

  const motivo = Perfil.motivoSlugNoDisponible(slugLimpio);
  if (motivo) return res.status(409).json({ error: `${motivo} Elige otra.` });

  try {
    const passwordHash = await bcrypt.hash(String(password), 12);

    // En una transaccion: si algo falla, ni se crea el perfil ni se gasta la
    // invitacion. Sin esto un error a medias dejaria la invitacion quemada.
    const alta = obtenerDB().transaction(() => {
      const perfil = Perfil.crear({
        slug: slugLimpio, name, role, tagline, footer, theme, links, hours, services, passwordHash,
        // El cliente eligio su propia clave: no hay nada que pedirle cambiar.
        mustChangePassword: false,
      });
      Invitacion.marcarUsada(token, slugLimpio);
      return perfil;
    });

    const perfil = alta();
    res.status(201).json({ profile: Perfil.aPublico(perfil) });
  } catch (err) {
    if (err.name === 'TypeError' || err instanceof RangeError) return next(err);
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------------------------------------- publico */

/** Lista completa de perfiles publicados. */
router.get('/', (_req, res) => {
  res.json(Perfil.listarPublicados().map(Perfil.aPublico));
});

router.get('/:slug', (req, res) => {
  const perfil = Perfil.porSlug(req.params.slug);
  if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
  res.json(Perfil.aPublico(perfil));
});

/** Cambios que le quedan hoy al dueño. Lo consulta su propio panel. */
router.get('/:slug/cupo', requireAuth, requireOwner, (req, res) => {
  res.json({ restantes: Perfil.cambiosRestantes(req.params.slug), limite: Perfil.limiteDiario() });
});

/** Sirve la imagen. La pide el frontend para /fotos/<slug>.webp y la cachea. */
router.get('/:slug/photo', (req, res) => {
  const fila = Perfil.obtenerFoto(req.params.slug);
  if (!fila?.photo) return res.status(404).json({ error: 'Sin foto' });

  res.set('Content-Type', fila.photo_type || 'image/webp');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(fila.photo);
});

/* ------------------------------------------------- edicion (dueño) */

router.put('/:slug', requireAuth, requireOwner, (req, res) => {
  if (!Perfil.porSlug(req.params.slug)) {
    return res.status(404).json({ error: 'Perfil no encontrado' });
  }

  // Lista blanca: el cliente edita contenido, nunca slug, clave ni estado.
  const permitidos = ['name', 'role', 'tagline', 'footer', 'links', 'theme', 'hours', 'services'];
  const cambios = {};
  for (const campo of permitidos) {
    if (req.body[campo] !== undefined) cambios[campo] = req.body[campo];
  }

  // Se comprueba antes de escribir: si el cliente ya gasto sus cambios de hoy,
  // el perfil se queda como estaba.
  const cupo = Perfil.registrarCambio(req.params.slug);
  if (!cupo.permitido) return res.status(429).json(errorDeCupo(cupo));

  let perfil;
  try {
    perfil = Perfil.actualizar(req.params.slug, cambios);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ profile: Perfil.aPublico(perfil), restantes: cupo.restantes });
});

/** Recibe la foto como data URL (base64) desde el panel. */
router.put('/:slug/photo', requireAuth, requireOwner, (req, res) => {
  const { dataUrl } = req.body || {};
  const match = /^data:(image\/(?:webp|jpeg|png));base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    return res.status(400).json({ error: 'Imagen invalida. Debe ser WebP, JPEG o PNG.' });
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_FOTO_BYTES) {
    return res.status(413).json({
      error: `La imagen pesa ${Math.round(buffer.length / 1024)} KB y el maximo es ${MAX_FOTO_BYTES / 1024} KB.`,
    });
  }

  const cupo = Perfil.registrarCambio(req.params.slug);
  if (!cupo.permitido) return res.status(429).json(errorDeCupo(cupo));

  if (!Perfil.guardarFoto(req.params.slug, buffer, match[1])) {
    return res.status(404).json({ error: 'Perfil no encontrado' });
  }

  res.json({ ok: true, bytes: buffer.length, restantes: cupo.restantes });
});

/* ----------------------------------------------------- administracion */

router.post('/', requireAdmin, async (req, res, next) => {
  const { slug, name, password, theme, role, tagline, footer, links, hours, services } = req.body || {};
  if (!slug || !name || !password) {
    return res.status(400).json({ error: 'slug, name y password son obligatorios' });
  }

  if (Perfil.porSlug(slug)) {
    return res.status(409).json({ error: 'Ya existe un perfil con ese slug' });
  }

  try {
    const perfil = Perfil.crear({
      slug, name, role, tagline, footer, theme, links, hours, services,
      passwordHash: await bcrypt.hash(String(password), 12),
    });
    res.status(201).json({ profile: Perfil.aPublico(perfil) });
  } catch (err) {
    if (err instanceof RangeError || err.name === 'TypeError') return next(err);
    res.status(400).json({ error: err.message });
  }
});

/** Restablece la clave de un cliente que la olvido. */
router.post('/:slug/reset-password', requireAdmin, async (req, res, next) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Falta la nueva clave' });

  try {
    const hash = await bcrypt.hash(String(password), 12);
    const cambios = Perfil.guardarClave(req.params.slug, hash, { mustChange: true });
    if (!cambios) return res.status(404).json({ error: 'Perfil no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Le devuelve a un cliente los cambios que ya gasto hoy. */
router.post('/:slug/reiniciar-cambios', requireAdmin, (req, res) => {
  if (!Perfil.reiniciarCambios(req.params.slug)) {
    return res.status(404).json({ error: 'Perfil no encontrado' });
  }
  res.json({ ok: true, restantes: Perfil.limiteDiario() });
});

router.patch('/:slug/published', requireAdmin, (req, res) => {
  if (!Perfil.cambiarPublicado(req.params.slug, Boolean(req.body?.published))) {
    return res.status(404).json({ error: 'Perfil no encontrado' });
  }
  res.json({ profile: Perfil.aPublico(Perfil.porSlug(req.params.slug)) });
});

export default router;
