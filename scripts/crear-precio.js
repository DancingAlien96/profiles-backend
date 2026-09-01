/**
 * Crea en Recurrente el producto con el precio recurrente de la suscripcion.
 *
 *   npm run crear-precio                 # $6.99 al mes
 *   npm run crear-precio -- --monto 9.99
 *
 * Se corre UNA sola vez. Imprime el id del precio, que va al .env como
 * RECURRENTE_PRICE_ID; a partir de ahi cada alta crea su cobro contra el.
 *
 * No lo hace la API al arrancar a proposito: crearia un producto nuevo en cada
 * despliegue y el panel de Recurrente acabaria lleno de duplicados.
 */
import 'dotenv/config';

const arg = (nombre, porDefecto = null) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
};

const MONTO = Number(arg('monto', '6.99'));
const MONEDA = arg('moneda', 'USD');
const NOMBRE = arg('nombre', 'Tarjeta de presentación digital');

if (!Number.isFinite(MONTO) || MONTO <= 0) {
  console.error(`\n  El monto "${arg('monto')}" no es valido.\n`);
  process.exit(1);
}

const { RECURRENTE_SECRET_KEY } = process.env;
if (!RECURRENTE_SECRET_KEY) {
  console.error(
    '\n  Falta RECURRENTE_SECRET_KEY en el .env.\n' +
      '  Esta en el panel de Recurrente, en Configuracion > Llaves API.\n'
  );
  process.exit(1);
}

// La clave decide el ambiente, asi que conviene decir en voz alta en cual se
// esta creando: un precio de sandbox no cobra dinero de verdad.
if (RECURRENTE_SECRET_KEY.startsWith('sk_test_')) {
  console.log('\n  [sandbox] la clave es de prueba: este precio no cobra dinero real.');
}

const BASE = process.env.RECURRENTE_API_URL || 'https://app.recurrente.com/api';

console.log(`\n  Creando "${NOMBRE}" a ${MONEDA} ${MONTO.toFixed(2)} al mes...\n`);

const res = await fetch(`${BASE}/products`, {
  method: 'POST',
  headers: {
    'X-SECRET-KEY': RECURRENTE_SECRET_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    product: {
      name: NOMBRE,
      prices_attributes: [
        {
          // La pasarela trabaja en centavos: 6.99 son 699.
          amount_in_cents: Math.round(MONTO * 100),
          currency: MONEDA,
          charge_type: 'recurring',
          billing_interval: 'month',
          billing_interval_count: 1,
        },
      ],
    },
  }),
  signal: AbortSignal.timeout(20000),
});

const cuerpo = await res.text();

if (!res.ok) {
  console.error(`  Recurrente respondio ${res.status}:\n  ${cuerpo.slice(0, 400)}\n`);
  process.exit(1);
}

const datos = JSON.parse(cuerpo);
const precio = datos.prices?.[0];

if (!precio?.id) {
  console.error('  Se creo el producto pero no vino el id del precio:\n', cuerpo.slice(0, 400));
  process.exit(1);
}

console.log(`  Producto : ${datos.name} (${datos.id})`);
console.log(`  Precio   : ${precio.id}\n`);
console.log('  Pegalo en el .env:\n');
console.log(`    RECURRENTE_PRICE_ID=${precio.id}\n`);
