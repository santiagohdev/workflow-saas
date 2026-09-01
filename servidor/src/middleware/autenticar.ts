/* ============================================================================
   Autenticación por JWT.

   Resuelve una única pregunta: quién es el que pide. A qué organización
   pertenece y qué puede hacer ahí adentro es problema de requireRole, y
   mantenerlo separado evita que una ruta quede protegida a medias.
   ========================================================================== */

import type { NextFunction, Response } from "express";
import { verificar } from "../servicios/jwt.ts";
import { ErrorHttp, type RequestAuth } from "../tipos.ts";

export function autenticar(req: RequestAuth, _res: Response, next: NextFunction): void {
  const cabecera = req.header("authorization") ?? "";
  const [esquema, token] = cabecera.split(" ");

  if (esquema?.toLowerCase() !== "bearer" || !token) {
    next(new ErrorHttp(401, "Falta el token de acceso.", "sin_token"));
    return;
  }

  const payload = verificar(token);
  if (!payload) {
    next(new ErrorHttp(401, "Token inválido o vencido.", "token_invalido"));
    return;
  }

  req.usuario = payload;
  next();
}
