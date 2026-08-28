import { obtenerDB } from '../db.js';
import { normalizarHorario } from '../lib/horarios.js';
import { normalizarUrl } from '../lib/enlaces.js';

export const TIPOS_ENLACE = [
  'whatsapp', 'linkedin', 'email', 'phone', 'web',
  'instagram', 'facebook', 'tiktok', 'catalogo', 'ubicacion',
];

const LIMITES = {
  slug: 40,
  name: 60,
  role: 80,
  tagline: 300,
  footer: 80,
  theme: 40,
  label: 40,
  sublabel: 60,
  url: 500,
  enlaces: 8,
};

const ahora = () => new Date().toISOString();

/* ------------------------------------------------- limite de cambios */

const LIMITE_POR_DEFECTO = 20;
const ZONA_POR_DEFECTO = 'America/Guatemala';

/**
 * Fecha de hoy en la zona del negocio, no la del servidor: si el VPS corre en
 * UTC, el contador se reiniciaria a media tarde para un cliente en Guatemala.
 */
function diaDeHoy() {
  const zona = process.env.ZONA_HORARIA || ZONA_POR_DEFECTO;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zona }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export const limiteDiario = () => {
  const valor = Number(process.env.EDICIONES_POR_DIA);
  return Number.isFinite(valor) && valor > 0 ? valor : LIMITE_POR_DEFECTO;
};

/**
 * Apunta un cambio del dueño y dice si puede seguir.
 *
 * Cada guardado acaba disparando un build de Netlify, cuyos minutos son
 * limitados; el tope evita que un cliente los agote el mismo dia. Se hace en
 * una transaccion para que dos peticiones a la vez no cuenten como una.
 *
 * Devuelve { permitido, restantes, limite }.
 */
export function registrarCambio(slug) {
  const db = obtenerDB();
  const limite = limiteDiario();
  const hoy = diaDeHoy();

  const operacion = db.transaction(() => {
    const fila = db
      .prepare('SELECT edits_day, edits_count FROM profiles WHERE slug = ?')
      .get(String(slug).toLowerCase());

    if (!fila) return { permitido: false, restantes: 0, limite, noExiste: true };

    // Dia nuevo: el contador vuelve a empezar.
    const usados = fila.edits_day === hoy ? fila.edits_count : 0;

    if (usados >= limite) return { permitido: false, restantes: 0, limite };

    db.prepare('UPDATE profiles SET edits_day = ?, edits_count = ? WHERE slug = ?')
      .run(hoy, usados + 1, String(slug).toLowerCase());

    return { permitido: true, restantes: limite - (usados + 1), limite };
  });

  return operacion();
}

/** Cuantos cambios le quedan hoy, sin apuntar ninguno. */
export function cambiosRestantes(slug) {
  const limite = limiteDiario();
  const fila = obtenerDB()
    .prepare('SELECT edits_day, edits_count FROM profiles WHERE slug = ?')
    .get(String(slug).toLowerCase());

  if (!fila) return limite;
  const usados = fila.edits_day === diaDeHoy() ? fila.edits_count : 0;
  return Math.max(0, limite - usados);
}

/** Devuelve los cambios de hoy a un cliente que se quedo sin ellos. */
export function reiniciarCambios(slug) {
  return obtenerDB()
    .prepare('UPDATE profiles SET edits_day = NULL, edits_count = 0 WHERE slug = ?')
    .run(String(slug).toLowerCase()).changes;
}

/**
 * Slugs que nadie puede tomar porque chocarian con una pagina del sitio o con
 * una ruta de la API. Sin esto, un cliente con el slug "crear" dejaria
 * inaccesible el formulario de alta.
 *
 * Si algun dia agregas una pagina nueva al frontend, añade su nombre aqui.
 */
export const RESERVADOS = new Set([
  'crear', 'admin', 'index', 'api', 'fotos', 'og', '404', 'registro',
  'disponible', 'todos', 'login', 'null', 'undefined', 'www', 'static', 'assets',
]);

/**
 * Devuelve por que un slug no se puede usar, o null si esta libre.
 * Lo comparten el alta de clientes y la creacion de invitaciones, para que
 * ambas apliquen exactamente la misma regla.
 */
export function motivoSlugNoDisponible(slug) {
  const s = String(slug || '').toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(s)) return 'Solo minusculas, numeros y guiones (3 a 40).';
  if (RESERVADOS.has(s)) return 'Esa direccion esta reservada.';
  if (porSlug(s)) return 'Ya esta ocupada.';
  return null;
}

/**
 * Primera variante libre de una direccion: dos clientes que se llamen igual
 * generan el mismo slug, y sin esto el segundo se queda atascado sin saber
 * que escribir.
 *
 * `ocupadoExtra` deja excluir tambien las direcciones apartadas por
 * invitaciones pendientes.
 */
export function sugerirSlug(base, ocupadoExtra = () => false) {
  const limpio = String(base || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 37);

  if (limpio.length < 3) return null;

  const libre = (s) => !RESERVADOS.has(s) && !porSlug(s) && !ocupadoExtra(s);

  if (libre(limpio)) return limpio;

  for (let n = 2; n <= 99; n++) {
    const candidato = `${limpio}-${n}`;
    if (libre(candidato)) return candidato;
  }
  return null;
}

/* ------------------------------------------------------- validacion */

/**
 * Valida los campos que el cliente puede enviar.
 * Devuelve un mensaje de error, o null si todo esta bien.
 */
export function validar(campos) {
  const texto = (v) => (typeof v === 'string' ? v.trim() : null);

  if (campos.slug !== undefined) {
    if (!/^[a-z0-9-]{3,40}$/.test(campos.slug)) {
      return 'El slug solo admite minusculas, numeros y guiones, entre 3 y 40 caracteres';
    }
  }

  if (campos.name !== undefined) {
    const v = texto(campos.name);
    if (!v) return 'El nombre es obligatorio';
    if (v.length > LIMITES.name) return `El nombre no puede pasar de ${LIMITES.name} caracteres`;
  }

  for (const campo of ['role', 'tagline', 'footer', 'theme']) {
    if (campos[campo] === undefined) continue;
    const v = texto(campos[campo]);
    if (v === null) return `El campo ${campo} debe ser texto`;
    if (v.length > LIMITES[campo]) {
      return `El campo ${campo} no puede pasar de ${LIMITES[campo]} caracteres`;
    }
  }

  if (campos.hours !== undefined) {
    const horario = normalizarHorario(campos.hours);
    if (horario.error) return horario.error;
  }

  if (campos.links !== undefined) {
    if (!Array.isArray(campos.links)) return 'Los enlaces deben ser una lista';
    if (campos.links.length > LIMITES.enlaces) return `Maximo ${LIMITES.enlaces} enlaces`;

    for (const enlace of campos.links) {
      if (!enlace || typeof enlace !== 'object') return 'Enlace invalido';
      if (!TIPOS_ENLACE.includes(enlace.type)) {
        return `Tipo de enlace no admitido: ${enlace.type}`;
      }
      const label = texto(enlace.label);
      const url = texto(enlace.url);
      if (!label) return 'Cada enlace necesita un texto de boton';
      if (!url) return 'Cada enlace necesita una direccion';
      if (!normalizarUrl(enlace.type, url)) {
        return `No se pudo armar el enlace de ${enlace.type} con "${url}"`;
      }
      if (label.length > LIMITES.label) return `El texto del boton no puede pasar de ${LIMITES.label} caracteres`;
      if (url.length > LIMITES.url) return `La direccion no puede pasar de ${LIMITES.url} caracteres`;
      if (enlace.sublabel && String(enlace.sublabel).length > LIMITES.sublabel) {
        return `El texto pequeño no puede pasar de ${LIMITES.sublabel} caracteres`;
      }
    }
  }

  return null;
}

/**
 * Normaliza los enlaces a la forma exacta que se guarda.
 * La direccion se arma segun el tipo, para que el cliente pueda escribir solo
 * su numero o su usuario en vez de la URL completa.
 */
const limpiarEnlaces = (links) =>
  (links || [])
    .map((e) => ({
      type: e.type,
      label: String(e.label).trim(),
      sublabel: e.sublabel ? String(e.sublabel).trim() : '',
      url: normalizarUrl(e.type, e.url),
    }))
    .filter((e) => e.url);

/* ------------------------------------------------------- conversion */

/** Version segura para el frontend: nunca expone hash ni binarios. */
export function aPublico(fila) {
  if (!fila) return null;
  return {
    slug: fila.slug,
    name: fila.name,
    role: fila.role,
    tagline: fila.tagline,
    footer: fila.footer,
    links: JSON.parse(fila.links),
    hours: fila.hours ? JSON.parse(fila.hours) : null,
    theme: fila.theme,
    published: Boolean(fila.published),
    hasPhoto: Boolean(fila.photo_updated_at),
    photoUpdatedAt: fila.photo_updated_at,
    mustChangePassword: Boolean(fila.must_change_password),
    updatedAt: fila.updated_at,
  };
}

/* --------------------------------------------------------- consultas */

// La columna photo se excluye a proposito: es el unico campo pesado y solo
// hace falta en la ruta que sirve la imagen.
const CAMPOS = `slug, name, role, tagline, footer, theme, links, hours,
  photo_type, photo_updated_at, must_change_password, failed_attempts,
  locked_until, published, created_at, updated_at`;

export function porSlug(slug) {
  return obtenerDB()
    .prepare(`SELECT ${CAMPOS} FROM profiles WHERE slug = ?`)
    .get(String(slug).toLowerCase());
}

/** Incluye el hash: solo para el login y el cambio de clave. */
export function porSlugConClave(slug) {
  return obtenerDB()
    .prepare(`SELECT ${CAMPOS}, password_hash FROM profiles WHERE slug = ?`)
    .get(String(slug).toLowerCase());
}

export function listarPublicados() {
  return obtenerDB()
    .prepare(`SELECT ${CAMPOS} FROM profiles WHERE published = 1 ORDER BY slug`)
    .all();
}

export function listarTodos() {
  return obtenerDB().prepare(`SELECT ${CAMPOS} FROM profiles ORDER BY slug`).all();
}

export function obtenerFoto(slug) {
  return obtenerDB()
    .prepare('SELECT photo, photo_type FROM profiles WHERE slug = ?')
    .get(String(slug).toLowerCase());
}

/* ------------------------------------------------------ escrituras */

/**
 * `mustChangePassword` va en true cuando la clave la generaste tu (deriva del
 * nombre y el telefono, asi que es adivinable) y en false cuando el cliente
 * la eligio el mismo al darse de alta.
 */
export function crear({
  slug, name, role, tagline, footer, theme, links, hours, passwordHash,
  mustChangePassword = true,
}) {
  const datos = {
    slug: String(slug).toLowerCase(),
    name: String(name).trim(),
    role: (role || '').trim(),
    tagline: (tagline || '').trim(),
    footer: (footer || '').trim(),
    theme: theme || 'oro-tech',
    links: links || [],
    hours,
  };

  const error = validar(datos);
  if (error) throw new Error(error);

  const horario = normalizarHorario(hours);

  const t = ahora();
  obtenerDB()
    .prepare(
      `INSERT INTO profiles
        (slug, name, role, tagline, footer, theme, links, hours, password_hash,
         must_change_password, published, created_at, updated_at)
       VALUES (@slug, @name, @role, @tagline, @footer, @theme, @links, @hours, @passwordHash,
         @mustChange, 1, @t, @t)`
    )
    .run({
      ...datos,
      links: JSON.stringify(limpiarEnlaces(datos.links)),
      hours: horario.hours ? JSON.stringify(horario.hours) : null,
      passwordHash,
      mustChange: mustChangePassword ? 1 : 0,
      t,
    });

  return porSlug(datos.slug);
}

/** Solo los campos de contenido. El slug, la clave y published no se tocan. */
export function actualizar(slug, campos) {
  const error = validar(campos);
  if (error) throw new Error(error);

  const editables = ['name', 'role', 'tagline', 'footer', 'theme'];
  const asignaciones = [];
  const valores = { slug: String(slug).toLowerCase(), t: ahora() };

  for (const campo of editables) {
    if (campos[campo] === undefined) continue;
    asignaciones.push(`${campo} = @${campo}`);
    valores[campo] = String(campos[campo]).trim();
  }

  if (campos.links !== undefined) {
    asignaciones.push('links = @links');
    valores.links = JSON.stringify(limpiarEnlaces(campos.links));
  }

  if (campos.hours !== undefined) {
    const horario = normalizarHorario(campos.hours);
    if (horario.error) throw new Error(horario.error);
    asignaciones.push('hours = @hours');
    valores.hours = horario.hours ? JSON.stringify(horario.hours) : null;
  }

  if (asignaciones.length) {
    obtenerDB()
      .prepare(`UPDATE profiles SET ${asignaciones.join(', ')}, updated_at = @t WHERE slug = @slug`)
      .run(valores);
  }

  return porSlug(slug);
}

export function guardarFoto(slug, buffer, tipo) {
  const t = ahora();
  return obtenerDB()
    .prepare(
      `UPDATE profiles SET photo = ?, photo_type = ?, photo_updated_at = ?, updated_at = ?
       WHERE slug = ?`
    )
    .run(buffer, tipo, t, t, String(slug).toLowerCase()).changes;
}

export function guardarClave(slug, passwordHash, { mustChange = false } = {}) {
  return obtenerDB()
    .prepare(
      `UPDATE profiles
         SET password_hash = ?, must_change_password = ?, failed_attempts = 0,
             locked_until = NULL, updated_at = ?
       WHERE slug = ?`
    )
    .run(passwordHash, mustChange ? 1 : 0, ahora(), String(slug).toLowerCase()).changes;
}

export function registrarIntentos(slug, { failedAttempts, lockedUntil = null }) {
  obtenerDB()
    .prepare('UPDATE profiles SET failed_attempts = ?, locked_until = ? WHERE slug = ?')
    .run(failedAttempts, lockedUntil, String(slug).toLowerCase());
}

export function cambiarPublicado(slug, published) {
  return obtenerDB()
    .prepare('UPDATE profiles SET published = ?, updated_at = ? WHERE slug = ?')
    .run(published ? 1 : 0, ahora(), String(slug).toLowerCase()).changes;
}

export function borrar(slug) {
  return obtenerDB()
    .prepare('DELETE FROM profiles WHERE slug = ?')
    .run(String(slug).toLowerCase()).changes;
}
