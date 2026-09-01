/* ============================================================================
   Registro, inicio de sesión y sesión actual.

   Registrarse crea tres cosas en una sola transacción: el usuario, su
   organización y la membresía que lo hace dueño. Si cualquiera de las tres
   falla no debe quedar ninguna: un usuario sin organización no puede hacer
   nada, y una organización sin dueño no la puede administrar nadie.
   ========================================================================== */

import { Router, type Response } from "express";
import { ahora, consultarTodos, consultarUno, ejecutar, enTransaccion, uuid } from "../db/base.ts";
import { hashear, verificar as verificarPassword } from "../servicios/password.ts";
import { emitir } from "../servicios/jwt.ts";
import { autenticar } from "../middleware/autenticar.ts";
import {
  ErrorHttp,
  type Organization,
  type RequestAuth,
  type Rol,
  type Usuario,
} from "../tipos.ts";

export const rutasAuth = Router();

function textoDe(valor: unknown, campo: string, max = 200): string {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new ErrorHttp(400, `Falta ${campo}.`, "campo_faltante");
  }
  const limpio = valor.trim();
  if (limpio.length > max) {
    throw new ErrorHttp(400, `${campo} no puede superar ${max} caracteres.`, "campo_largo");
  }
  return limpio;
}

function normalizarEmail(valor: unknown): string {
  const email = textoDe(valor, "el email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ErrorHttp(400, "El email no tiene un formato válido.", "email_invalido");
  }
  return email;
}

/** Convierte un nombre en un identificador de URL y le garantiza unicidad. */
async function generarSlug(nombre: string): Promise<string> {
  const base =
    nombre
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "organizacion";

  let candidato = base;
  let n = 1;
  while (await consultarUno("SELECT 1 FROM organizations WHERE slug = ?", candidato)) {
    candidato = `${base}-${++n}`;
  }
  return candidato;
}

/* --------------------------------------------------------------------------
   POST /api/auth/register
   -------------------------------------------------------------------------- */
rutasAuth.post("/register", async (req, res, next) => {
  try {
    const cuerpo = req.body as Record<string, unknown>;
    const email = normalizarEmail(cuerpo["email"]);
    const nombre = textoDe(cuerpo["name"], "tu nombre", 120);
    const organizacion = textoDe(cuerpo["organization_name"], "el nombre de la organización", 120);
    const contrasena = cuerpo["password"];

    if (typeof contrasena !== "string" || contrasena.length < 8) {
      throw new ErrorHttp(400, "La contraseña debe tener al menos 8 caracteres.", "password_corta");
    }

    if (await consultarUno("SELECT 1 FROM users WHERE email = ?", email)) {
      throw new ErrorHttp(409, "Ya existe una cuenta con ese email.", "email_en_uso");
    }

    const hash = await hashear(contrasena);
    const momento = ahora();
    const usuarioId = uuid();
    const orgId = uuid();
    const slug = await generarSlug(organizacion);

    await enTransaccion(async () => {
      await ejecutar(
        `INSERT INTO users (id, email, name, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        usuarioId, email, nombre, hash, momento,
      );

      await ejecutar(
        `INSERT INTO organizations
           (id, name, slug, plan, subscription_status, stripe_customer_id, created_at, updated_at)
         VALUES (?, ?, ?, 'free', 'inactive', NULL, ?, ?)`,
        orgId, organizacion, slug, momento, momento,
      );

      await ejecutar(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
        orgId, usuarioId, momento,
      );
    });

    const token = emitir({ sub: usuarioId, email, name: nombre });
    res.status(201).json({
      token,
      usuario: { id: usuarioId, email, name: nombre },
      organizaciones: [{ id: orgId, name: organizacion, slug, role: "owner" as Rol }],
    });
  } catch (error) {
    next(error);
  }
});

/* --------------------------------------------------------------------------
   POST /api/auth/login
   -------------------------------------------------------------------------- */
rutasAuth.post("/login", async (req, res, next) => {
  try {
    const cuerpo = req.body as Record<string, unknown>;
    const email = normalizarEmail(cuerpo["email"]);
    const contrasena = cuerpo["password"];

    if (typeof contrasena !== "string" || contrasena.length === 0) {
      throw new ErrorHttp(400, "Falta la contraseña.", "campo_faltante");
    }

    const usuario = await consultarUno<Usuario>("SELECT * FROM users WHERE email = ?", email);

    /* Mismo mensaje para email inexistente y contraseña incorrecta: decir
       cuál de los dos falló permite averiguar qué emails están registrados. */
    const generico = new ErrorHttp(401, "Email o contraseña incorrectos.", "credenciales");

    if (!usuario) throw generico;
    if (!(await verificarPassword(contrasena, usuario.password_hash))) throw generico;

    const token = emitir({ sub: usuario.id, email: usuario.email, name: usuario.name });
    res.json({
      token,
      usuario: { id: usuario.id, email: usuario.email, name: usuario.name },
      organizaciones: await organizacionesDe(usuario.id),
    });
  } catch (error) {
    next(error);
  }
});

/* --------------------------------------------------------------------------
   GET /api/auth/me
   -------------------------------------------------------------------------- */
rutasAuth.get("/me", autenticar, async (req: RequestAuth, res: Response, next) => {
  try {
    const usuario = req.usuario;
    if (!usuario) throw new ErrorHttp(401, "Sesión no iniciada.", "sin_sesion");

    const fila = await consultarUno<Omit<Usuario, "password_hash">>(
      "SELECT id, email, name, created_at FROM users WHERE id = ?",
      usuario.sub,
    );

    if (!fila) throw new ErrorHttp(401, "La cuenta ya no existe.", "sin_cuenta");

    res.json({ usuario: fila, organizaciones: await organizacionesDe(fila.id) });
  } catch (error) {
    next(error);
  }
});

export async function organizacionesDe(
  usuarioId: string,
): Promise<
  Array<Pick<Organization, "id" | "name" | "slug" | "plan" | "subscription_status"> & { role: Rol }>
> {
  return consultarTodos<
    Pick<Organization, "id" | "name" | "slug" | "plan" | "subscription_status"> & { role: Rol }
  >(
    `SELECT o.id, o.name, o.slug, o.plan, o.subscription_status, m.role
       FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ?
      ORDER BY o.created_at ASC`,
    usuarioId,
  );
}
