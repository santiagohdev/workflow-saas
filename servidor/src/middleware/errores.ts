/* ============================================================================
   Manejo central de errores.

   Los 4xx llevan el mensaje que escribimos nosotros, porque el cliente
   necesita saber qué corregir. Los 5xx devuelven un texto genérico: el
   detalle de un fallo interno —una consulta, una ruta, un nombre de tabla— es
   información útil para quien esté buscando cómo entrar, y no le sirve de
   nada al usuario legítimo. El detalle va al log del servidor.
   ========================================================================== */

import type { NextFunction, Request, Response } from "express";
import { ErrorHttp } from "../tipos.ts";
import { config } from "../config.ts";

export function noEncontrado(_req: Request, res: Response): void {
  res.status(404).json({ error: "Ruta no encontrada.", codigo: "ruta_inexistente" });
}

export function manejarErrores(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ErrorHttp) {
    res.status(error.status).json({ error: error.message, codigo: error.codigo });
    return;
  }

  const detalle = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[error no controlado]", detalle);

  res.status(500).json({
    error: "Error interno del servidor.",
    codigo: "error_interno",
    ...(config.esProduccion ? {} : { detalle: String(detalle).split("\n")[0] }),
  });
}
