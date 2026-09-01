/* ============================================================================
   Organización: uso del plan y gestión de miembros.
   ========================================================================== */

import { Router, type Response } from "express";
import { ahora, consultarTodos, consultarUno, ejecutar, enTransaccion, uuid } from "../db/base.ts";
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
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion;
      if (!org) throw new ErrorHttp(500, "Falta la organización en la petición.");

      const efectivo = planEfectivo(org.plan, org.subscription_status);
      const tableros = await contarTableros(org.id);
      const miembros = await contarMiembros(org.id);

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
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const miembros = await consultarTodos(
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
        org.id,
      );
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
  async (req: RequestAuth, res: Response, next) => {
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

      const usuario = await consultarUno<Usuario>("SELECT * FROM users WHERE email = ?", email);
      if (!usuario) {
        throw new ErrorHttp(
          404,
          "No hay ninguna cuenta con ese email. La persona tiene que registrarse primero.",
          "usuario_inexistente",
        );
      }

      const yaEsta = await consultarUno(
        "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?",
        org.id,
        usuario.id,
      );
      if (yaEsta) {
        throw new ErrorHttp(409, "Esa persona ya es miembro.", "ya_es_miembro");
      }

      await ejecutar(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
        org.id, usuario.id, rol, ahora(),
      );

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
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const objetivo = req.params["userId"]!;

      const membresia = await consultarUno<{ role: Rol }>(
        "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?",
        org.id,
        objetivo,
      );

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
        const owners = await consultarUno<{ n: string }>(
          "SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'owner'",
          org.id,
        );
        /* COUNT() vuelve como bigint y el driver lo entrega en texto para no
           perder precisión. Comparar "1" <= 1 sin convertir da falso. */
        if (Number(owners?.n ?? 0) <= 1) {
          throw new ErrorHttp(
            409,
            "No se puede quitar al único dueño. Nombrá otro dueño primero.",
            "ultimo_owner",
          );
        }
      }

      await ejecutar(
        "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
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
rutasOrganizaciones.post("/", autenticar, async (req: RequestAuth, res: Response, next) => {
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
    while (await consultarUno("SELECT 1 FROM organizations WHERE slug = ?", slug)) {
      slug = `${base}-${++n}`;
    }

    const id = uuid();
    const momento = ahora();

    /* La organización y su dueño van juntos: una organización sin dueño no la
       puede administrar nadie. */
    await enTransaccion(async () => {
      await ejecutar(
        `INSERT INTO organizations
           (id, name, slug, plan, subscription_status, stripe_customer_id, created_at, updated_at)
         VALUES (?, ?, ?, 'free', 'inactive', NULL, ?, ?)`,
        id, nombre, slug, momento, momento,
      );

      await ejecutar(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
        id, req.usuario!.sub, momento,
      );
    });

    res.status(201).json({ organizacion: { id, name: nombre, slug, role: "owner" } });
  } catch (error) {
    next(error);
  }
});
