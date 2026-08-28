/**
 * Horario de atencion.
 *
 * Forma guardada (JSON en la columna `hours`):
 *
 *   {
 *     "tz": "America/Guatemala",
 *     "days": [
 *       { "closed": true },
 *       { "ranges": [["08:00","12:00"], ["14:00","18:00"]] },
 *       ...   // siete entradas, la primera es lunes
 *     ]
 *   }
 *
 * Se admiten dos turnos por dia porque cerrar a mediodia es lo habitual aqui.
 */

export const DIAS = 7;
export const MAX_TURNOS = 2;
export const TZ_POR_DEFECTO = 'America/Guatemala';

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const aMinutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Comprueba y normaliza un horario.
 * Devuelve { hours } con la forma limpia, o { error } con el motivo.
 * Un horario vacio (o sin ningun dia abierto) se guarda como null: la tarjeta
 * simplemente no muestra la seccion.
 */
export function normalizarHorario(entrada) {
  if (entrada === null || entrada === undefined || entrada === '') return { hours: null };
  if (typeof entrada !== 'object' || Array.isArray(entrada)) {
    return { error: 'El horario tiene un formato invalido' };
  }

  const tz = typeof entrada.tz === 'string' && entrada.tz.length <= 60 ? entrada.tz : TZ_POR_DEFECTO;

  // La zona horaria decide si el negocio esta abierto ahora, asi que una
  // invalida haria que el calculo reventara en el navegador del visitante.
  try {
    new Intl.DateTimeFormat('es', { timeZone: tz });
  } catch {
    return { error: `Zona horaria desconocida: ${tz}` };
  }

  const dias = Array.isArray(entrada.days) ? entrada.days : [];
  if (dias.length && dias.length !== DIAS) {
    return { error: 'El horario debe traer los siete dias' };
  }

  const limpios = [];
  let algunoAbierto = false;

  for (let i = 0; i < DIAS; i++) {
    const dia = dias[i] || {};

    if (dia.closed || !Array.isArray(dia.ranges) || !dia.ranges.length) {
      limpios.push({ closed: true });
      continue;
    }

    if (dia.ranges.length > MAX_TURNOS) {
      return { error: `Maximo ${MAX_TURNOS} turnos por dia` };
    }

    const turnos = [];
    for (const turno of dia.ranges) {
      if (!Array.isArray(turno) || turno.length !== 2) {
        return { error: 'Cada turno necesita hora de apertura y de cierre' };
      }
      const [abre, cierra] = turno.map((h) => String(h).trim());

      if (!HORA.test(abre) || !HORA.test(cierra)) {
        return { error: `Hora invalida: "${abre}" o "${cierra}". Usa el formato 08:30` };
      }
      if (aMinutos(cierra) <= aMinutos(abre)) {
        return { error: `El cierre (${cierra}) debe ser despues de la apertura (${abre})` };
      }
      turnos.push([abre, cierra]);
    }

    // Ordenar y comprobar que los turnos no se pisen entre si.
    turnos.sort((a, b) => aMinutos(a[0]) - aMinutos(b[0]));
    if (turnos.length === 2 && aMinutos(turnos[1][0]) < aMinutos(turnos[0][1])) {
      return { error: 'Los dos turnos de un mismo dia se solapan' };
    }

    algunoAbierto = true;
    limpios.push({ ranges: turnos });
  }

  if (!algunoAbierto) return { hours: null };
  return { hours: { tz, days: limpios } };
}
