/**
 * Armado de enlaces a partir de lo que escribe el cliente.
 *
 * Nadie deberia tener que saber que WhatsApp se enlaza con "https://wa.me/502"
 * delante del numero, ni acordarse del "mailto:" o del "https://". El cliente
 * escribe su numero, su correo o su usuario y aqui se convierte en un enlace
 * que funciona.
 *
 * Si ya escribio la direccion completa, se respeta tal cual.
 */

const CODIGO_PAIS = process.env.CODIGO_PAIS || '502';

// Los numeros locales de Guatemala tienen 8 digitos.
const LARGO_LOCAL = 8;

const soloDigitos = (v) => String(v).replace(/\D/g, '');
const yaEsUrl = (v) => /^(https?:|mailto:|tel:)/i.test(String(v).trim());

/** "4769 4804" -> "50247694804". Respeta el codigo de pais si ya viene. */
function telefonoInternacional(valor) {
  const digitos = soloDigitos(valor);
  if (!digitos) return null;

  if (digitos.length === LARGO_LOCAL) return `${CODIGO_PAIS}${digitos}`;
  if (digitos.startsWith(CODIGO_PAIS)) return digitos;

  // Otra longitud: se asume que ya trae su propio codigo de pais.
  return digitos;
}

/** Quita la arroba y cualquier URL alrededor para quedarse con el usuario. */
function usuarioDeRed(valor, dominio) {
  const limpio = String(valor).trim().replace(/^@/, '');
  const desdeUrl = limpio.match(new RegExp(`${dominio}/@?([^/?#]+)`, 'i'));
  return (desdeUrl ? desdeUrl[1] : limpio).replace(/^@/, '');
}

/**
 * Convierte lo escrito en una direccion utilizable.
 * Devuelve null si no hay nada aprovechable.
 */
export function normalizarUrl(tipo, valor) {
  const bruto = String(valor || '').trim();
  if (!bruto) return null;

  switch (tipo) {
    case 'whatsapp': {
      if (/^https?:/i.test(bruto)) return bruto;
      const numero = telefonoInternacional(bruto);
      return numero ? `https://wa.me/${numero}` : null;
    }

    case 'phone': {
      if (yaEsUrl(bruto)) return bruto;
      const numero = telefonoInternacional(bruto);
      return numero ? `tel:+${numero}` : null;
    }

    case 'email': {
      if (/^mailto:/i.test(bruto)) return bruto;
      return bruto.includes('@') ? `mailto:${bruto}` : null;
    }

    case 'instagram':
      if (/^https?:/i.test(bruto)) return bruto;
      return `https://instagram.com/${usuarioDeRed(bruto, 'instagram\\.com')}`;

    case 'tiktok':
      if (/^https?:/i.test(bruto)) return bruto;
      return `https://tiktok.com/@${usuarioDeRed(bruto, 'tiktok\\.com')}`;

    case 'facebook':
      if (/^https?:/i.test(bruto)) return bruto;
      return `https://facebook.com/${usuarioDeRed(bruto, 'facebook\\.com')}`;

    case 'linkedin':
      if (/^https?:/i.test(bruto)) return bruto;
      return `https://www.linkedin.com/in/${usuarioDeRed(bruto, 'linkedin\\.com/in')}`;

    // Sitio web, catalogo y ubicacion: casi siempre se pega la direccion
    // completa, pero mucha gente la escribe sin el "https://" delante.
    default:
      return yaEsUrl(bruto) ? bruto : `https://${bruto.replace(/^\/+/, '')}`;
  }
}
