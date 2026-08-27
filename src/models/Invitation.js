import crypto from 'node:crypto';
import { obtenerDB } from '../db.js';

const DIAS_VALIDEZ = 14;

const ahora = () => new Date().toISOString();

/** Crea una invitacion y devuelve el token en claro. */
export function crear({ nota = '', plantilla = null, slug = null, dias = DIAS_VALIDEZ } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const creada = new Date();
  const expira = new Date(creada.getTime() + dias * 24 * 60 * 60 * 1000);

  obtenerDB()
    .prepare(
      `INSERT INTO invitations (token, nota, plantilla, slug, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      token,
      String(nota).slice(0, 120),
      plantilla,
      slug ? String(slug).toLowerCase() : null,
      creada.toISOString(),
      expira.toISOString()
    );

  return { token, nota, plantilla, slug, expiresAt: expira.toISOString() };
}

/**
 * Slug apartado por una invitacion todavia utilizable.
 * Evita entregar dos tarjetas NFC con la misma direccion.
 */
export function slugApartado(slug) {
  return obtenerDB()
    .prepare(
      `SELECT token FROM invitations
        WHERE slug = ? AND used_at IS NULL AND expires_at > ?`
    )
    .get(String(slug).toLowerCase(), ahora());
}

export function porToken(token) {
  if (!token) return null;
  return obtenerDB().prepare('SELECT * FROM invitations WHERE token = ?').get(String(token));
}

/**
 * Comprueba si una invitacion sirve todavia.
 * Devuelve { ok: true, invitacion } o { ok: false, motivo }.
 */
export function revisar(token) {
  const invitacion = porToken(token);
  if (!invitacion) {
    return { ok: false, motivo: 'Esta invitacion no existe. Pide un enlace nuevo.' };
  }
  if (invitacion.used_at) {
    return { ok: false, motivo: 'Esta invitacion ya se uso para crear un perfil.' };
  }
  if (new Date(invitacion.expires_at) < new Date()) {
    return { ok: false, motivo: 'Esta invitacion caduco. Pide un enlace nuevo.' };
  }
  return { ok: true, invitacion };
}

export function marcarUsada(token, slug) {
  return obtenerDB()
    .prepare('UPDATE invitations SET used_at = ?, used_by_slug = ? WHERE token = ? AND used_at IS NULL')
    .run(ahora(), slug, String(token)).changes;
}

export function listar() {
  return obtenerDB().prepare('SELECT * FROM invitations ORDER BY created_at DESC').all();
}

export function borrar(token) {
  return obtenerDB().prepare('DELETE FROM invitations WHERE token = ?').run(String(token)).changes;
}

export function aPublico(inv) {
  if (!inv) return null;
  return {
    token: inv.token,
    nota: inv.nota,
    plantilla: inv.plantilla,
    slug: inv.slug,
    createdAt: inv.created_at,
    expiresAt: inv.expires_at,
    usedAt: inv.used_at,
    usedBySlug: inv.used_by_slug,
  };
}
