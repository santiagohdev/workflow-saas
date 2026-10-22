/* ============================================================================
   Base embebida para la demostración.

   PGlite es PostgreSQL compilado a WebAssembly: corre dentro del mismo proceso,
   sin servidor aparte ni proyecto externo. Un proyecto gratuito de Supabase se
   pausa después de una semana sin actividad y no vuelve solo; esta base no
   tiene nada que se pueda pausar.

   Vive en memoria, así que arranca vacía en cada inicio y el servidor le carga
   los datos de ejemplo. Lo que cambien los visitantes se descarta en el próximo
   reinicio, y en una demostración pública eso es una ventaja.

   Se expone por un socket local para que el resto de la aplicación no se
   entere: el driver `pg` se conecta como a cualquier PostgreSQL. Los paquetes
   se cargan recién acá, así que un despliegue con base externa no los usa.
   ========================================================================== */

const PUERTO = 55432;

let detener: (() => Promise<void>) | undefined;

/** Levanta la base y devuelve su cadena de conexión. */
export async function iniciarBaseEmbebida(): Promise<string> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const db = await PGlite.create({ extensions: { pgcrypto } });
  const servidor = new PGLiteSocketServer({ db, host: "127.0.0.1", port: PUERTO });
  await servidor.start();

  detener = async () => {
    await servidor.stop();
    await db.close();
  };

  console.log("base embebida lista (PGlite, en memoria)");
  return `postgresql://postgres@127.0.0.1:${PUERTO}/postgres`;
}

/** Apaga la base embebida, si está levantada. El socket abierto, si no,
    mantiene vivo el proceso. */
export async function cerrarBaseEmbebida(): Promise<void> {
  await detener?.();
}
