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
import { baseResponde, cerrar, migrar } from "./db/base.ts";
import { cargarDatosDemo } from "./db/semilla.ts";
import { rutasAuth } from "./rutas/auth.ts";
import { rutasOrganizaciones } from "./rutas/organizaciones.ts";
import { rutasTableros } from "./rutas/tableros.ts";
import { rutasStripe } from "./rutas/stripe.ts";
import { manejarErrores, noEncontrado } from "./middleware/errores.ts";

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

/* --- Hasta que la base está lista, la API responde 503. ---

   Si la base no responde al arrancar, el servidor levanta igual y la sigue
   esperando (ver el final del archivo). Mientras tanto el panel carga y quien
   intenta entrar lee un mensaje claro. El chequeo de salud queda afuera: es
   justamente el que tiene que informar el problema. */
let baseLista = false;

app.use("/api", (req, res, next) => {
  if (baseLista || req.path === "/health") return next();
  res.status(503).set("Retry-After", "30").json({
    error: "La base de datos no está disponible en este momento. Probá de nuevo en unos minutos.",
    codigo: "base_no_disponible",
  });
});

/* --- El webhook, con el cuerpo crudo, antes que cualquier parser. --- */
app.use("/api/webhooks", express.raw({ type: "application/json", limit: "1mb" }), rutasStripe);

/* --- A partir de acá, JSON normal. --- */
app.use(express.json({ limit: "1mb" }));

/* El chequeo de salud consulta la base, no solo el proceso: un servidor que
   contesta pero no llega a la base está caído para quien lo usa.

   Está pensado para un monitor externo que lo llame cada pocos minutos. En los
   planes gratuitos eso además evita dos apagones: Render duerme la instancia
   a los 15 minutos sin tráfico, y Supabase pausa el proyecto tras una semana
   sin actividad en la base. */
app.get("/api/health", async (_req, res) => {
  const base = baseLista && (await baseResponde());
  res.status(base ? 200 : 503).json({
    ok: base,
    base: base ? "ok" : "sin conexión",
    entorno: config.entorno,
    hora: new Date().toISOString(),
  });
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

/* El esquema se aplica antes de aceptar tráfico. Levantar primero y migrar
   después deja una ventana en la que las primeras peticiones fallan contra
   tablas que todavía no existen.

   Si la base no responde, el servidor levanta igual y reintenta solo, cada vez
   más espaciado. Terminar el proceso no arregla nada: la plataforma lo relanza
   en bucle y quien entra ve una pantalla de carga que nunca termina. */
async function prepararBase(): Promise<boolean> {
  try {
    await migrar();
    /* La base embebida trae los datos de ejemplo en su imagen. Si la imagen
       falta, arranca vacía y sin esto la demo no tendría con qué entrar. */
    if (config.baseEmbebida) await cargarDatosDemo();
    baseLista = true;
    return true;
  } catch (error) {
    console.error("no se pudo preparar la base:", error instanceof Error ? error.message : error);
    return false;
  }
}

async function reintentarBase(): Promise<void> {
  for (let intento = 1; ; intento++) {
    const segundos = Math.min(60, 5 * intento);
    console.log(`nuevo intento con la base en ${segundos} s`);
    await new Promise((listo) => setTimeout(listo, segundos * 1000));
    if (await prepararBase()) {
      console.log("base de datos lista");
      return;
    }
  }
}

if (!(await prepararBase())) void reintentarBase();

const servidor = app.listen(config.puerto, () => {
  console.log(`servidor escuchando en http://localhost:${config.puerto}  [${config.entorno}]`);
});

/* --------------------------------------------------------------------------
   Que Render no la duerma.

   Render apaga la instancia gratuita a los 15 minutos sin tráfico entrante.
   El workflow mantener-activa la consulta cada 5 minutos, pero GitHub atrasa
   seguido las tareas programadas más que eso. Mientras está levantado, el
   servidor se consulta a sí mismo por la URL pública: la petición da la vuelta
   por internet, entra por donde entra una visita y cuenta como tráfico. El
   workflow queda para despertarlo cuando igual se durmió.

   De 4 a 7 UTC no se consulta, igual que en el workflow: las 750 horas
   gratuitas de Render por mes son para todos los servicios de la cuenta.
   -------------------------------------------------------------------------- */
const MINUTOS_ENTRE_CONSULTAS = 5;
const HORAS_SIN_CONSULTAS_UTC = [4, 5, 6];

if (config.urlPublica) {
  setInterval(async () => {
    if (HORAS_SIN_CONSULTAS_UTC.includes(new Date().getUTCHours())) return;
    try {
      const respuesta = await fetch(`${config.urlPublica}/api/health`, {
        signal: AbortSignal.timeout(30_000),
      });
      await respuesta.body?.cancel();
      if (!respuesta.ok) console.error(`la consulta propia devolvió ${respuesta.status}`);
    } catch (error) {
      console.error("la consulta propia falló:", error instanceof Error ? error.message : error);
    }
  }, MINUTOS_ENTRE_CONSULTAS * 60_000).unref();

  console.log(`consulta propia cada ${MINUTOS_ENTRE_CONSULTAS} min a ${config.urlPublica}`);
}

/* Cerrar ordenado: sin esto, un reinicio deja peticiones a medias. */
for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    console.log(`\n${senal} recibida, cerrando...`);
    servidor.close(() => {
      /* El pool mantiene sockets abiertos: sin cerrarlo el proceso queda vivo
         hasta que la plataforma lo mata por timeout. */
      void cerrar().finally(() => process.exit(0));
    });
  });
}

export { app };
