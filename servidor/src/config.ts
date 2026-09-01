/* ============================================================================
   Configuración.

   Se valida al arrancar, no en el momento de usarse. Un servidor que levanta
   sin la clave de firma y falla recién cuando alguien intenta iniciar sesión
   es peor que uno que no levanta: el error aparece en producción.
   ========================================================================== */

import "dotenv/config";

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

const databaseUrl = texto("DATABASE_URL", "");
if (!databaseUrl.startsWith("postgres")) {
  throw new Error(
    "DATABASE_URL falta o no es una cadena de PostgreSQL. " +
      "En Supabase: Project Settings → Database → Connection string → URI.",
  );
}

export const config = Object.freeze({
  puerto: entero("PORT", 4000),
  entorno: texto("NODE_ENV", "development"),
  esProduccion: texto("NODE_ENV", "development") === "production",

  corsOrigins: texto("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),

  jwtSecret,
  jwtExpiraHoras: entero("JWT_EXPIRA_HORAS", 12),

  databaseUrl,

  /* Supabase corta a 60 conexiones directas y los planes chicos de Render
     levantan más de una instancia. Un pool holgado por instancia agota la
     base antes de que el tráfico lo justifique. */
  poolMax: entero("DB_POOL_MAX", 8),

  stripeWebhookSecret: texto("STRIPE_WEBHOOK_SECRET", "whsec_local_de_prueba"),

  limiteTablerosGratis: entero("LIMITE_TABLEROS_GRATIS", 3),
  limiteMiembrosGratis: entero("LIMITE_MIEMBROS_GRATIS", 5),
});
