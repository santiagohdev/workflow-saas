/* ============================================================================
   Configuración.

   Se valida al arrancar, no en el momento de usarse. Un servidor que levanta
   sin la clave de firma y falla recién cuando alguien intenta iniciar sesión
   es peor que uno que no levanta: el error aparece en producción.
   ========================================================================== */

import "dotenv/config";
import { randomBytes } from "node:crypto";

function texto(nombre: string, porDefecto: string): string {
  const v = process.env[nombre]?.trim();
  return v && v.length > 0 ? v : porDefecto;
}

function entero(nombre: string, porDefecto: number): number {
  const bruto = process.env[nombre]?.trim();
  if (!bruto) return porDefecto;
  const n = Number.parseInt(bruto, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${nombre} debe ser un entero no negativo; llegó "${bruto}".`);
  }
  return n;
}

const jwtSecret = texto("JWT_SECRET", "");
if (jwtSecret.length < 16) {
  throw new Error(
    "JWT_SECRET falta o es demasiado corto (mínimo 16 caracteres). " +
      "Copiá .env.example a .env y completalo.",
  );
}

/* La demostración pública corre con la base embebida (ver db/embebida.ts):
   así no depende de un proyecto externo que se pueda pausar. Con ella no hace
   falta DATABASE_URL, y si está, se ignora. */
const baseEmbebida = texto("BASE_EMBEBIDA", "") === "true";

const databaseUrl = texto("DATABASE_URL", "");
if (!baseEmbebida && !databaseUrl.startsWith("postgres")) {
  throw new Error(
    "DATABASE_URL falta o no es una cadena de PostgreSQL. " +
      "En Supabase: Project Settings → Database → Connection string → URI.",
  );
}

const esProduccion = texto("NODE_ENV", "development") === "production";
const permitirSimulacionDePagos = texto("DEMO_SIMULAR_PAGOS", "") === "true";

/* El secreto del webhook es lo único que impide mandar un pago inventado y
   pasarse a premium. El valor de ejemplo está publicado en este repositorio:
   en producción no sirve como secreto.

   En una demostración no hay Stripe real —la firma la hace el propio servidor
   al simular el pago—, así que alcanza con un secreto aleatorio por arranque,
   que nadie de afuera puede conocer. En un despliegue real, que falte es un
   error de configuración y el servidor no arranca. */
const SECRETO_DE_EJEMPLO = "whsec_local_de_prueba";
let stripeWebhookSecret = texto("STRIPE_WEBHOOK_SECRET", SECRETO_DE_EJEMPLO);

if (esProduccion && stripeWebhookSecret === SECRETO_DE_EJEMPLO) {
  if (!permitirSimulacionDePagos) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET falta o tiene el valor de ejemplo. En producción va el secreto " +
        "real del webhook (Stripe → Developers → Webhooks), o DEMO_SIMULAR_PAGOS=true si es una demo.",
    );
  }
  stripeWebhookSecret = `whsec_${randomBytes(24).toString("hex")}`;
}

export const config = Object.freeze({
  puerto: entero("PORT", 4000),
  entorno: texto("NODE_ENV", "development"),
  esProduccion,

  corsOrigins: texto("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),

  jwtSecret,
  jwtExpiraHoras: entero("JWT_EXPIRA_HORAS", 12),

  databaseUrl,
  baseEmbebida,

  /* Supabase corta a 60 conexiones directas y los planes chicos de Render
     levantan más de una instancia. Un pool holgado por instancia agota la
     base antes de que el tráfico lo justifique. */
  poolMax: entero("DB_POOL_MAX", 8),

  stripeWebhookSecret,

  /* La ruta que simula el webhook permite activarse premium sin pagar, así que
     en producción está apagada. Un despliegue de demostración es el único caso
     legítimo para encenderla, y tiene que pedirse a propósito: por eso es una
     variable aparte y no se deduce de NODE_ENV. Nunca en un entorno con
     clientes reales. */
  permitirSimulacionDePagos,

  limiteTablerosGratis: entero("LIMITE_TABLEROS_GRATIS", 3),
  limiteMiembrosGratis: entero("LIMITE_MIEMBROS_GRATIS", 5),
});
