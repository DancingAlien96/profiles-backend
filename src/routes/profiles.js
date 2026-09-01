import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import * as Perfil from '../models/Profile.js';
import * as Invitacion from '../models/Invitation.js';
import { requireAuth, requireOwner, requireAdmin } from '../middleware/auth.js';
import * as Suscripcion from '../models/Suscripcion.js';
import { crearCheckout } from '../lib/recurrente.js';
import { obtenerDB } from '../db.js';

const router = Router();

// La foto llega ya comprimida por el navegador (400x400 WebP). Este limite
// es la red de seguridad por si alguien llama la API por fuera del panel.
const MAX_FOTO_BYTES = 200 * 1024;

/* ------------------------------------------------------- alta de clientes */

// Van antes de "/:slug" a proposito: en Express gana la primera que coincida,
// y "registro" es un slug sintacticamente valido.

/**
 * Dominio del sitio, para las direcciones de vuelta de la pasarela.
 * Sin barra final: se le concatenan rutas.
 */
const sitio = () =>
  (process.env.SITE_URL || 'https://www.professionalprofiles.online').replace(/\/$/, '');

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

/**
 * El alta publica, sin invitacion, no tiene ninguna puerta antes: cualquiera
 * que abra la portada llega aqui. El limite es mas estrecho porque cada alta
 * aparta una direccion, y las direcciones no se reciclan solas hasta pasada
 * una hora.
 */
const registroPublicoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Ya empezaste varias tarjetas desde aqui. Termina el pago de una o espera un rato.',
  },
});

/** El limite estrecho solo se aplica al alta sin invitacion. */
const limitarSiEsPublico = (req, res, next) =>
  req.body?.token ? next() : registroPublicoLimiter(req, res, next);

/** Lista para el panel de administracion: incluye los despublicados. */
router.get('/todos', requireAdmin, (_req, res) => {
  res.json(Perfil.listarTodos().map(Perfil.aPublico));
});

router.get('/disponible/:slug', (req, res) => {
  // Se sueltan primero las direcciones apartadas y nunca pagadas: si no,
  // decirle a alguien que "clinica" esta ocupada por un alta que murio a
  // medias hace semanas seria mentirle.
  Suscripcion.liberarAbandonadas();

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

/**
 * Alta del cliente. Dos caminos por la misma puerta:
 *
 *  - Con invitacion: la que le mandas tu. Puede traer la direccion fijada,
 *    para cuando el codigo QR o la tarjeta NFC ya estan impresos.
 *  - Sin invitacion: cualquiera desde la portada. El pago es la unica puerta.
 *
 * Se conservan las dos porque la invitacion sigue haciendo algo que el alta
 * publica no puede: decidir la direccion antes de que el cliente escriba nada.
 */
router.post('/registro', registroLimiter, limitarSiEsPublico, async (req, res, next) => {
  const { token, slug, name, role, tagline, footer, theme, links, hours, services, password } = req.body || {};

  // Antes de decidir nada sobre direcciones, se sueltan las que alguien
  // aparto y nunca pago. Si no, un nombre queda bloqueado por una alta a
  // medias que nunca va a completarse.
  Suscripcion.liberarAbandonadas();

  const revision = token ? Invitacion.revisar(token) : { ok: true, invitacion: {} };
  if (!revision.ok) return res.status(410).json({ error: revision.motivo });

  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'La clave debe tener al menos 8 caracteres' });
  }

  // Si la invitacion trae direccion fijada, manda esa y se ignora lo que envie
  // el cliente: la tarjeta NFC y el QR ya estan impresos con ella.
  const slugLimpio = revision.invitacion.slug || String(slug || '').toLowerCase();

  // Ademas de las direcciones ya usadas, se respetan las que estan apartadas
  // por una invitacion sin gastar. Esas son las de los codigos QR y tarjetas
  // NFC ya impresos: si alguien se lleva una, la tarjeta de plastico del
  // cliente apunta a la pagina de otra persona y no hay forma de arreglarlo.
  //
  // La comprobacion vive aqui y no solo en /disponible porque esa ruta es una
  // ayuda del formulario, no una defensa: se puede llamar a esta directamente.
  const apartada = Invitacion.slugApartado(slugLimpio);
  const laApartoOtro = apartada && apartada.token !== token;

  const motivo =
    Perfil.motivoSlugNoDisponible(slugLimpio) ||
    (laApartoOtro ? 'Esa direccion ya esta apartada para otro cliente.' : null);

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
        // Se publica cuando entre el pago, no antes.
        published: false,
      });
      // Solo hay invitacion que gastar en el camino que la usa.
      if (token) Invitacion.marcarUsada(token, slugLimpio);
      return perfil;
    });

    const perfil = alta();

    // La tarjeta ya existe, pero no se ve: se publica sola cuando la pasarela
    // confirme el primer cobro. Se crea antes de cobrar a proposito, para
    // apartar la direccion: si se creara despues, dos altas simultaneas con el
    // mismo nombre podrian pagar las dos por la misma direccion.
    Suscripcion.crearPendiente(slugLimpio);

    let pago;
    try {
      pago = await crearCheckout({
        slug: slugLimpio,
        exitoUrl: `${sitio()}/pago/listo?t=${slugLimpio}`,
        cancelUrl: `${sitio()}/pago/cancelado?t=${slugLimpio}`,
      });
      Suscripcion.crearPendiente(slugLimpio, { checkoutId: pago.id });
    } catch (err) {
      // El perfil queda creado y sin publicar. Se le puede volver a generar el
      // cobro desde el panel, sin que el cliente rellene el formulario otra
      // vez ni pierda su direccion.
      console.error(`[registro] no se pudo crear el cobro de ${slugLimpio}:`, err.message);
      return res.status(502).json({
        error:
          'Tu tarjeta quedo guardada, pero no se pudo abrir el pago. Escribenos y la activamos.',
        profile: Perfil.aPublico(perfil),
      });
    }

    res.status(201).json({ profile: Perfil.aPublico(perfil), urlPago: pago.url });
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

  // `acceso` solo dice si la tarjeta se muestra entera o no. El estado real de
  // la suscripcion no sale de aqui: quien abre la tarjeta es un prospecto del
  // cliente, y no tiene por que enterarse de que su cobro fallo.
  res.json({ ...Perfil.aPublico(perfil), acceso: Suscripcion.acceso(req.params.slug) });
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
