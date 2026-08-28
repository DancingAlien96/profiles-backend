/**
 * Servicios que ofrece el cliente: lo que hace, en una cuadricula.
 *
 * Cada uno es { label, icon }. El icono sale de un catalogo cerrado: si se
 * dejara libre, un cliente podria meter cualquier cosa en el HTML de su
 * tarjeta.
 */

export const ICONOS_SERVICIO = [
  'check', 'consulta', 'corazon', 'diente', 'ojo', 'pastilla',
  'documento', 'tijeras', 'brocha', 'casa', 'llave', 'herramienta',
  'camara', 'carrito', 'calculadora', 'balanza', 'estrella', 'reloj',
];

export const MAX_SERVICIOS = 8;
const MAX_TEXTO = 40;

/**
 * Comprueba y normaliza la lista.
 * Devuelve { services } o { error } con el motivo.
 */
export function normalizarServicios(entrada) {
  if (entrada === null || entrada === undefined) return { services: [] };
  if (!Array.isArray(entrada)) return { error: 'Los servicios deben ser una lista' };
  if (entrada.length > MAX_SERVICIOS) return { error: `Maximo ${MAX_SERVICIOS} servicios` };

  const limpios = [];
  for (const servicio of entrada) {
    if (!servicio || typeof servicio !== 'object') return { error: 'Servicio invalido' };

    const label = String(servicio.label || '').trim();
    if (!label) continue; // los vacios simplemente no se guardan
    if (label.length > MAX_TEXTO) {
      return { error: `Cada servicio no puede pasar de ${MAX_TEXTO} caracteres` };
    }

    const icon = ICONOS_SERVICIO.includes(servicio.icon) ? servicio.icon : 'check';
    limpios.push({ label, icon });
  }

  return { services: limpios };
}
