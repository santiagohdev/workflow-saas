/* ============================================================================
   Imagen de la base de la demo.

   Genera demo/base.tar.gz: la base embebida con el esquema y los datos de
   ejemplo ya cargados, que el servidor abre al arrancar con BASE_EMBEBIDA=true
   (ver db/embebida.ts). Regenerarla cuando cambian el esquema o los datos:

     npm run demo:imagen
   ========================================================================== */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RUTA_IMAGEN, volcarBaseEmbebida } from "./embebida.ts";

/* Sin la imagen anterior, la base arranca vacía. base.ts levanta la base al
   importarse, por eso se importa recién después de borrarla. */
rmSync(RUTA_IMAGEN, { force: true });
const { cerrar, ejecutar, migrar } = await import("./base.ts");
const { cargarDatosDemo } = await import("./semilla.ts");

await migrar();
await cargarDatosDemo();
await ejecutar("checkpoint");

mkdirSync(dirname(RUTA_IMAGEN), { recursive: true });
const imagen = await volcarBaseEmbebida();
writeFileSync(RUTA_IMAGEN, new Uint8Array(await imagen.arrayBuffer()));
console.log(`imagen guardada en ${RUTA_IMAGEN} (${Math.round(imagen.size / 1024)} KB)`);

await cerrar();
