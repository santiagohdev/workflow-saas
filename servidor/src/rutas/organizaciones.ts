/* ============================================================================
   Organización: uso del plan y gestión de miembros.
   ========================================================================== */

import { Router, type Response } from "express";
import { ahora, db, uuid } from "../db/base.ts";
import { autenticar } from "../middleware/autenticar.ts";
import { requireRole } from "../middleware/requireRole.ts";
import {
  checkPlanLimits,
  contarMiembros,
  contarTableros,
  limiteDe,
  planEfectivo,
} from "../middleware/checkPlanLimits.ts";
import { config } from "../config.ts";
import { ErrorHttp, JERARQUIA, type RequestAuth, type Rol, type Usuario } from "../tipos.ts";

export const rutasOrganizaciones = Router();

const ROLES_VALIDOS: readonly Rol[] = ["owner", "admin", "member", "viewer"];

/* --------------------------------------------------------------------------
   GET /api/organizations/:orgId/usage
   Alimenta el panel de facturación.
   -------------------------------------------------------------------------- */
rutasOrganizaciones.get(
  "/:orgId/usage",
  autenticar,
  requireRole("viewer"),
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion;
      if (!org) throw new ErrorHttp(500, "Falta la organización en la petición.");

      const efectivo = planEfectivo(org.plan, org.subscription_status);
      const tableros = contarTableros(org.id);
      const miembros = contarMiembros(org.id);

      res.json({
        organizacion: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          plan: org.plan,
          subscription_status: org.subscription_status,
          plan_efectivo: efectivo,
        },
        rol: req.rol,
        uso: {
          boards: {
            usado: tableros,
            limite: efectivo === "premium" ? null : limiteDe("boards"),
          },
          members: {
            usado: miembros,
            limite: efectivo === "premium" ? null : limiteDe("members"),
          },
        },
        limites_plan_gratis: {
          boards: config.limiteTablerosGratis,
          members: config.limiteMiembrosGratis,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   GET /api/organizations/:orgId/members
   -------------------------------------------------------------------------- */
rutasOrganizaciones.get(
  "/:orgId/members",
  autenticar,
  requireRole("viewer"),
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const miembros = db
        .prepare(
          `SELECT u.id, u.email, u.name, m.role, m.created_at
             FROM organization_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = ?
            ORDER BY
              CASE m.role
                WHEN 'owner'  THEN 1
                WHEN 'admin'  THEN 2
                WHEN 'member' THEN 3
                ELSE 4
              END,
              u.name`,
        )
        .all(org.id);
      res.json({ miembros });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   POST /api/organizations/:orgId/members
   Suma un usuario existente. Cuenta contra el límite del plan.
   -------------------------------------------------------------------------- */
rutasOrganizaciones.post(
  "/:orgId/members",
  autenticar,
  requireRole("admin"),
  checkPlanLimits("members"),
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const cuerpo = req.body as Record<string, unknown>;

      const email = typeof cuerpo["email"] === "string" ? cuerpo["email"].trim().toLowerCase() : "";
      const rolPedido = cuerpo["role"];

      if (!email) throw new ErrorHttp(400, "Falta el email del miembro.", "campo_faltante");

      const rol: Rol =
        typeof rolPedido === "string" && (ROLES_VALIDOS as readonly string[]).includes(rolPedido)
          ? (rolPedido as Rol)
          : "member";

      /* Nadie puede otorgar un rol por encima del propio: un admin que pueda
         nombrar owners se convierte en owner cuando quiera. */
      const rolPropio = req.rol!;
      if (JERARQUIA[rol] > JERARQUIA[rolPropio]) {
        throw new ErrorHttp(
          403,
          `No podés asignar el rol ${rol} porque el tuyo es ${rolPropio}.`,
          "rol_superior",
        );
      }

      const usuario = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
        | Usuario
        | undefined;
      if (!usuario) {
        throw new ErrorHttp(
          404,
          "No hay ninguna cuenta con ese email. La persona tiene que registrarse primero.",
          "usuario_inexistente",
        );
      }

      const yaEsta = db
        .prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?")
        .get(org.id, usuario.id);
      if (yaEsta) {
        throw new ErrorHttp(409, "Esa persona ya es miembro.", "ya_es_miembro");
      }

      db.prepare(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(org.id, usuario.id, rol, ahora());

      res.status(201).json({
        miembro: { id: usuario.id, email: usuario.email, name: usuario.name, role: rol },
      });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   DELETE /api/organizations/:orgId/members/:userId
   -------------------------------------------------------------------------- */
rutasOrganizaciones.delete(
  "/:orgId/members/:userId",
  autenticar,
  requireRole("admin"),
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const objetivo = req.params["userId"]!;

      const membresia = db
        .prepare("SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?")
        .get(org.id, objetivo) as { role: Rol } | undefined;

      if (!membresia) throw new ErrorHttp(404, "Esa persona no es miembro.", "no_miembro");

      if (JERARQUIA[membresia.role] >= JERARQUIA[req.rol!] && objetivo !== req.usuario!.sub) {
        throw new ErrorHttp(
          403,
          "No podés quitar a alguien con un rol igual o superior al tuyo.",
          "rol_superior",
        );
      }

      /* Una organización sin dueño queda sin nadie que pueda administrarla. */
      if (membresia.role === "owner") {
        const owners = db
          .prepare(
            "SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'owner'",
          )
          .get(org.id) as { n: number };
        if (owners.n <= 1) {
          throw new ErrorHttp(
            409,
            "No se puede quitar al único dueño. Nombrá otro dueño primero.",
            "ultimo_owner",
          );
        }
      }

      db.prepare("DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?").run(
        org.id,
        objetivo,
      );

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   POST /api/organizations
   Crea una organización adicional. Quien la crea queda como dueño.
   -------------------------------------------------------------------------- */
rutasOrganizaciones.post("/", autenticar, (req: RequestAuth, res: Response, next) => {
  try {
    const cuerpo = req.body as Record<string, unknown>;
    const nombre = typeof cuerpo["name"] === "string" ? cuerpo["name"].trim() : "";
    if (!nombre) throw new ErrorHttp(400, "Falta el nombre de la organización.", "campo_faltante");

    const base =
      nombre
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "organizacion";

    let slug = base;
    let n = 1;
    while (db.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(slug)) {
      slug = `${base}-${++n}`;
    }

    const id = uuid();
    const momento = ahora();

    db.prepare(
      `INSERT INTO organizations
         (id, name, slug, plan, subscription_status, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 'inactive', NULL, ?, ?)`,
    ).run(id, nombre, slug, momento, momento);

    db.prepare(
      `INSERT INTO organization_members (organization_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`,
    ).run(id, req.usuario!.sub, momento);

    res.status(201).json({ organizacion: { id, name: nombre, slug, role: "owner" } });
  } catch (error) {
    next(error);
  }
});
