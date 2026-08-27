import { obtenerDB } from '../db.js';

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
      if (label.length > LIMITES.label) return `El texto del boton no puede pasar de ${LIMITES.label} caracteres`;
      if (url.length > LIMITES.url) return `La direccion no puede pasar de ${LIMITES.url} caracteres`;
      if (enlace.sublabel && String(enlace.sublabel).length > LIMITES.sublabel) {
        return `El texto pequeño no puede pasar de ${LIMITES.sublabel} caracteres`;
      }
    }
  }

  return null;
}

/** Normaliza los enlaces a la forma exacta que se guarda. */
const limpiarEnlaces = (links) =>
  (links || []).map((e) => ({
    type: e.type,
    label: String(e.label).trim(),
    sublabel: e.sublabel ? String(e.sublabel).trim() : '',
    url: String(e.url).trim(),
  }));

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
const CAMPOS = `slug, name, role, tagline, footer, theme, links,
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

export function crear({ slug, name, role, tagline, footer, theme, links, passwordHash }) {
  const datos = {
    slug: String(slug).toLowerCase(),
    name: String(name).trim(),
    role: (role || '').trim(),
    tagline: (tagline || '').trim(),
    footer: (footer || '').trim(),
    theme: theme || 'oro-tech',
    links: links || [],
  };

  const error = validar(datos);
  if (error) throw new Error(error);

  const t = ahora();
  obtenerDB()
    .prepare(
      `INSERT INTO profiles
        (slug, name, role, tagline, footer, theme, links, password_hash,
         must_change_password, published, created_at, updated_at)
       VALUES (@slug, @name, @role, @tagline, @footer, @theme, @links, @passwordHash,
         1, 1, @t, @t)`
    )
    .run({ ...datos, links: JSON.stringify(limpiarEnlaces(datos.links)), passwordHash, t });

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
