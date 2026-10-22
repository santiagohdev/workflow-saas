/* ============================================================================
   Base embebida para la demostración.

   PGlite es PostgreSQL compilado a WebAssembly: corre dentro del mismo proceso,
   sin servidor aparte ni proyecto externo. Un proyecto gratuito de Supabase se
   pausa después de una semana sin actividad y no vuelve solo; esta base no
   tiene nada que se pueda pausar.

   Cada inicio parte de la imagen de la demo (RUTA_IMAGEN), copiada a una
   carpeta temporal que se borra al cerrar: lo que cambien los visitantes se
   descarta en el próximo reinicio, y en una demostración pública eso es una
   ventaja.

   Se expone por un socket local para que el resto de la aplicación no se
   entere: el driver `pg` se conecta como a cualquier PostgreSQL. Los paquetes
   se cargan recién acá, así que un despliegue con base externa no los usa.
   ========================================================================== */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PUERTO = 55432;

/* Imagen de la base con el esquema y los datos de ejemplo ya cargados.

   Crear la base desde cero (initdb) pasa los 600 MB de memoria, y la
   instancia gratuita de Render tiene 512: abrir una imagen ya hecha usa cerca
   de la mitad. Se regenera con `npm run demo:imagen` cuando cambian el
   esquema o los datos de ejemplo. Si no está, la base se crea desde cero. */
export const RUTA_IMAGEN = resolve(import.meta.dirname, "../../demo/base.tar.gz");

let detener: (() => Promise<void>) | undefined;
let volcar: (() => Promise<Blob>) | undefined;

/** Levanta la base y devuelve su cadena de conexión. */
export async function iniciarBaseEmbebida(): Promise<string> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const imagen = existsSync(RUTA_IMAGEN)
    ? new Blob([new Uint8Array(readFileSync(RUTA_IMAGEN))])
    : undefined;

  /* Los archivos de la base van a una carpeta temporal y no a memoria: en
     memoria suman decenas de MB más, que en 512 no sobran. Se borra al cerrar,
     así que la base sigue empezando de cero en cada arranque. */
  const carpeta = mkdtempSync(join(tmpdir(), "workflow-demo-"));

  /* Postgres viene configurado para un servidor y reserva 128 MB de búfer
     compartido. Para una demo con un puñado de filas alcanza con mucho menos,
     y en 512 MB esa diferencia decide si la instancia arranca o se queda sin
     memoria. */
  const db = await PGlite.create({
    dataDir: carpeta,
    extensions: { pgcrypto },
    loadDataDir: imagen,
    startParams: [
      ...PGlite.defaultStartParams,
      "-c", "shared_buffers=16MB",
      "-c", "maintenance_work_mem=8MB",
    ],
  });
  /* El límite por defecto es una conexión, y una que se corta con error queda
     contada para siempre (ver base.ts). Con margen, un corte no deja a la
     demo sin base. */
  const servidor = new PGLiteSocketServer({ db, host: "127.0.0.1", port: PUERTO, maxConnections: 8 });
  await servidor.start();

  detener = async () => {
    await servidor.stop();
    await db.close();
    rmSync(carpeta, { recursive: true, force: true });
  };
  volcar = () => db.dumpDataDir("gzip");

  console.log(`base embebida lista (PGlite${imagen ? ", desde la imagen" : ""})`);
  return `postgresql://postgres@127.0.0.1:${PUERTO}/postgres`;
}

/** La base embebida entera, como imagen comprimida. */
export async function volcarBaseEmbebida(): Promise<Blob> {
  if (!volcar) throw new Error("La base embebida no está levantada.");
  return volcar();
}

/** Apaga la base embebida, si está levantada. El socket abierto, si no,
    mantiene vivo el proceso. */
export async function cerrarBaseEmbebida(): Promise<void> {
  await detener?.();
}
