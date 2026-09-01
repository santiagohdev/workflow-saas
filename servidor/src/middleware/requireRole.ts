/* ============================================================================
   requireRole — pertenencia y jerarquía de roles.

   Hace dos verificaciones que siempre van juntas:

   1. Que el usuario sea miembro de la organización que dice la petición. Esta
      es la barrera de aislamiento entre inquilinos: sin ella, cualquiera con
      una sesión válida podría leer los tableros de otra empresa cambiando un
      identificador en la URL.

   2. Que su rol alcance el mínimo requerido, comparando números en la
      jerarquía en vez de enumerar roles permitidos ruta por ruta.

   Deja la organización y el rol resueltos en la request, para que los
   controladores no tengan que volver a consultarlos.
   ========================================================================== */

import type { NextFunction, Response } from "express";
import { consultarUno } from "../db/base.ts";
import {
  ErrorHttp,
  JERARQUIA,
  type Organization,
  type RequestAuth,
  type Rol,
} from "../tipos.ts";

/** Toma la organización de la ruta, del cuerpo o de la query, en ese orden. */
function organizacionDeLaPeticion(req: RequestAuth): string | null {
  const deRuta = req.params["orgId"];
  if (typeof deRuta === "string" && deRuta.length > 0) return deRuta;

  const cuerpo = req.body as Record<string, unknown> | undefined;
  const deCuerpo = cuerpo?.["organization_id"];
  if (typeof deCuerpo === "string" && deCuerpo.length > 0) return deCuerpo;

  const deQuery = req.query["organization_id"];
  if (typeof deQuery === "string" && deQuery.length > 0) return deQuery;

  return null;
}

export function requireRole(minimo: Rol) {
  return async function verificarRol(
    req: RequestAuth,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const usuario = req.usuario;
    if (!usuario) {
      next(new ErrorHttp(401, "Sesión no iniciada.", "sin_sesion"));
      return;
    }

    const orgId = organizacionDeLaPeticion(req);
    if (!orgId) {
      next(new ErrorHttp(400, "Falta organization_id en la petición.", "sin_organizacion"));
      return;
    }

    let membresia: (Organization & { role: Rol }) | undefined;
    try {
      membresia = await consultarUno<Organization & { role: Rol }>(
      `SELECT m.role, o.id, o.name, o.slug, o.plan, o.subscription_status,
              o.stripe_customer_id, o.created_at, o.updated_at
         FROM organization_members m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = ? AND m.user_id = ?`,
        orgId,
        usuario.sub,
      );
    } catch (error) {
      next(error);
      return;
    }

    /* No pertenece. Se responde 404 y no 403 a propósito: un 403 confirmaría
       que esa organización existe, y eso ya es información que no le
       corresponde a quien no es miembro. */
    if (!membresia) {
      next(new ErrorHttp(404, "La organización no existe o no sos miembro.", "no_miembro"));
      return;
    }

    if (JERARQUIA[membresia.role] < JERARQUIA[minimo]) {
      next(
        new ErrorHttp(
          403,
          `Se requiere rol ${minimo} o superior. Tu rol actual es ${membresia.role}.`,
          "rol_insuficiente",
        ),
      );
      return;
    }

    const { role, ...organizacion } = membresia;
    req.rol = role;
    req.organizacion = organizacion;
    next();
  };
}
