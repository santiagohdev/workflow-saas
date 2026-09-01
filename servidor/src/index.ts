/* ============================================================================
   Punto de entrada.

   El orden del middleware acá no es estético: es funcional.

   La ruta del webhook de Stripe se monta con express.raw() ANTES de
   express.json(). Si el parser de JSON corre primero, el cuerpo original se
   pierde y la verificación de firma —que se hace sobre los bytes exactos que
   mandó Stripe— falla siempre. Es el error más común al integrar webhooks y
   es difícil de diagnosticar porque el código "parece" correcto.
   ========================================================================== */

import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { migrar } from "./db/base.ts";
import { rutasAuth } from "./rutas/auth.ts";
import { rutasOrganizaciones } from "./rutas/organizaciones.ts";
import { rutasTableros } from "./rutas/tableros.ts";
import { rutasStripe } from "./rutas/stripe.ts";
import { manejarErrores, noEncontrado } from "./middleware/errores.ts";

migrar();

const app = express();

app.disable("x-powered-by");

/* Orígenes permitidos: los configurados más el propio servidor.

   Incluir el origen propio no es un detalle: cuando el panel compilado se
   sirve desde acá, el navegador pide los módulos con cabecera Origin y, sin
   esta línea, se rechazarían sus propios archivos.

   Un origen no permitido se responde con `false`, no con un Error. Devolver un
   Error lo convierte en un 500, que además de ser el código equivocado hace
   fallar peticiones que no son del navegador. Lo correcto es no emitir las
   cabeceras de CORS y dejar que el navegador bloquee, que es su trabajo. */
const origenPropio = `http://localhost:${config.puerto}`;
const ORIGENES = new Set([...config.corsOrigins, origenPropio, `http://127.0.0.1:${config.puerto}`]);

app.use(
  cors({
    origin(origen, callback) {
      // Sin origen: curl, health checks, peticiones servidor a servidor.
      if (!origen) return callback(null, true);
      return callback(null, ORIGENES.has(origen));
    },
    credentials: true,
  }),
);

/* --- El webhook, con el cuerpo crudo, antes que cualquier parser. --- */
app.use("/api/webhooks", express.raw({ type: "application/json", limit: "1mb" }), rutasStripe);

/* --- A partir de acá, JSON normal. --- */
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, entorno: config.entorno, hora: new Date().toISOString() });
});

app.use("/api/auth", rutasAuth);
app.use("/api/organizations", rutasOrganizaciones);
app.use("/api/boards", rutasTableros);
app.use("/api/billing", rutasStripe);

/* --------------------------------------------------------------------------
   Panel compilado.

   Si existe panel/dist, el mismo servidor lo sirve. Eso deja la aplicación
   completa en un solo origen: desaparece CORS y desaparece la necesidad de
   dos procesos, que es como conviene desplegarla.

   El comodín va DESPUÉS de las rutas de la API. Si fuera antes, se tragaría
   /api/* y devolvería el HTML del panel en vez de JSON.
   -------------------------------------------------------------------------- */
const RUTA_PANEL = resolve(process.cwd(), "..", "panel", "dist");

if (existsSync(RUTA_PANEL)) {
  app.use(express.static(RUTA_PANEL));

  /* El panel maneja su propia navegación: cualquier ruta que no sea de la API
     devuelve index.html y deja que el cliente decida qué mostrar. */
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(resolve(RUTA_PANEL, "index.html"));
  });

  console.log(`panel servido desde ${RUTA_PANEL}`);
} else {
  console.log("panel/dist no existe: corré `npm run build` en panel/ para servirlo desde acá.");
}

app.use(noEncontrado);
app.use(manejarErrores);

const servidor = app.listen(config.puerto, () => {
  console.log(`servidor escuchando en http://localhost:${config.puerto}  [${config.entorno}]`);
});

/* Cerrar ordenado: sin esto, un reinicio deja peticiones a medias. */
for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    console.log(`\n${senal} recibida, cerrando...`);
    servidor.close(() => process.exit(0));
  });
}

export { app };
