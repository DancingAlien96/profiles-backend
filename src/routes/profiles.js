import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import * as Perfil from '../models/Profile.js';
import * as Invitacion from '../models/Invitation.js';
import { requireAuth, requireOwner, requireAdmin } from '../middleware/auth.js';
import { scheduleRebuild } from '../lib/rebuild.js';
import { obtenerDB } from '../db.js';

const router = Router();

// La foto llega ya comprimida por el navegador (400x400 WebP). Este limite
// es la red de seguridad por si alguien llama la API por fuera del panel.
const MAX_FOTO_BYTES = 200 * 1024;

/**
 * Slugs que no puede tomar un cliente porque chocarian con una pagina del
 * sitio o con una ruta de la API. Sin esto, alguien con el slug "crear"
 * dejaria inaccesible el formulario de alta.
 */
const RESERVADOS = new Set([
  'crear', 'admin', 'index', 'api', 'fotos', 'og', '404', 'registro',
  'disponible', 'todos', 'login', 'null', 'undefined', 'www', 'static', 'assets',
]);

/* ------------------------------------------------------- alta de clientes */

// Van antes de "/:slug" a proposito: en Express gana la primera que coincida,
// y "registro" es un slug sintacticamente valido.

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

  if (!/^[a-z0-9-]{3,40}$/.test(slug)) {
    return res.json({ disponible: false, motivo: 'Solo minusculas, numeros y guiones (3 a 40).' });
  }
  if (RESERVADOS.has(slug)) {
    return res.json({ disponible: false, motivo: 'Esa direccion esta reservada.' });
  }
  if (Perfil.porSlug(slug)) {
    return res.json({ disponible: false, motivo: 'Ya esta ocupada.' });
  }
  res.json({ disponible: true });
});

/** Alta desde el enlace de invitacion. La invitacion se gasta al usarse. */
router.post('/registro', registroLimiter, async (req, res, next) => {
  const { token, slug, name, role, tagline, footer, theme, links, password } = req.body || {};

  const revision = Invitacion.revisar(token);
  if (!revision.ok) return res.status(410).json({ error: revision.motivo });

  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'La clave debe tener al menos 8 caracteres' });
  }

  const slugLimpio = String(slug || '').toLowerCase();
  if (RESERVADOS.has(slugLimpio)) {
    return res.status(409).json({ error: 'Esa direccion esta reservada. Elige otra.' });
  }
  if (Perfil.porSlug(slugLimpio)) {
    return res.status(409).json({ error: 'Esa direccion ya esta ocupada. Elige otra.' });
  }

  try {
    const passwordHash = await bcrypt.hash(String(password), 12);

    // En una transaccion: si algo falla, ni se crea el perfil ni se gasta la
    // invitacion. Sin esto un error a medias dejaria la invitacion quemada.
    const alta = obtenerDB().transaction(() => {
      const perfil = Perfil.crear({
        slug: slugLimpio, name, role, tagline, footer, theme, links, passwordHash,
        // El cliente eligio su propia clave: no hay nada que pedirle cambiar.
        mustChangePassword: false,
      });
      Invitacion.marcarUsada(token, slugLimpio);
      return perfil;
    });

    const perfil = alta();
    scheduleRebuild();
    res.status(201).json({ profile: Perfil.aPublico(perfil) });
  } catch (err) {
    if (err.name === 'TypeError' || err instanceof RangeError) return next(err);
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------------------------------------- publico */

/** Lista completa. La consume el build de Netlify para generar las paginas. */
router.get('/', (_req, res) => {
  res.json(Perfil.listarPublicados().map(Perfil.aPublico));
});

router.get('/:slug', (req, res) => {
  const perfil = Perfil.porSlug(req.params.slug);
  if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
  res.json(Perfil.aPublico(perfil));
});

/** Sirve la imagen. La usa el build para bajarla y publicarla en Netlify. */
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
  const permitidos = ['name', 'role', 'tagline', 'footer', 'links', 'theme'];
  const cambios = {};
  for (const campo of permitidos) {
    if (req.body[campo] !== undefined) cambios[campo] = req.body[campo];
  }

  let perfil;
  try {
    perfil = Perfil.actualizar(req.params.slug, cambios);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  scheduleRebuild();
  res.json({ profile: Perfil.aPublico(perfil), rebuild: true });
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

  if (!Perfil.guardarFoto(req.params.slug, buffer, match[1])) {
    return res.status(404).json({ error: 'Perfil no encontrado' });
  }

  scheduleRebuild();
  res.json({ ok: true, bytes: buffer.length });
});

/* ----------------------------------------------------- administracion */

router.post('/', requireAdmin, async (req, res, next) => {
  const { slug, name, password, theme, role, tagline, footer, links } = req.body || {};
  if (!slug || !name || !password) {
    return res.status(400).json({ error: 'slug, name y password son obligatorios' });
  }

  if (Perfil.porSlug(slug)) {
    return res.status(409).json({ error: 'Ya existe un perfil con ese slug' });
  }

  try {
    const perfil = Perfil.crear({
      slug, name, role, tagline, footer, theme, links,
      passwordHash: await bcrypt.hash(String(password), 12),
    });
    scheduleRebuild();
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

router.patch('/:slug/published', requireAdmin, (req, res) => {
  if (!Perfil.cambiarPublicado(req.params.slug, Boolean(req.body?.published))) {
    return res.status(404).json({ error: 'Perfil no encontrado' });
  }
  scheduleRebuild();
  res.json({ profile: Perfil.aPublico(Perfil.porSlug(req.params.slug)) });
});

export default router;
