/* ============================================================================
   Tipos del dominio.

   El esquema SQL y este archivo cuentan la misma historia. Cuando cambie una
   tabla, este es el primer archivo que se toca.
   ========================================================================== */

import type { Request } from "express";

export type Plan = "free" | "premium";
export type EstadoSuscripcion = "active" | "inactive";
export type Rol = "owner" | "admin" | "member" | "viewer";
export type Prioridad = "low" | "medium" | "high" | "urgent";

/* Jerarquía de roles. Un número mayor puede todo lo que puede uno menor.
   Tenerla como dato y no como una cadena de if permite que requireRole sea
   una sola comparación y que agregar un rol no obligue a revisar cada ruta. */
export const JERARQUIA: Readonly<Record<Rol, number>> = Object.freeze({
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
});

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  subscription_status: EstadoSuscripcion;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Usuario {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

/** Usuario tal como sale hacia el cliente: nunca incluye el hash. */
export type UsuarioPublico = Omit<Usuario, "password_hash">;

export interface Membresia {
  organization_id: string;
  user_id: string;
  role: Rol;
  created_at: string;
}

export interface Board {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Columna {
  id: string;
  organization_id: string;
  board_id: string;
  name: string;
  position: number;
  created_at: string;
}

export interface Tarea {
  id: string;
  organization_id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string;
  priority: Prioridad;
  position: number;
  assignee_id: string | null;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Contenido del JWT. */
export interface PayloadToken {
  sub: string;
  email: string;
  name: string;
  /** Emitido en (segundos epoch). */
  iat: number;
  /** Expira en (segundos epoch). */
  exp: number;
}

/** Request después de pasar por autenticar. */
export interface RequestAuth extends Request {
  usuario?: PayloadToken;
  /** La organización del contexto, resuelta por requireRole. */
  organizacion?: Organization;
  /** El rol del usuario dentro de esa organización. */
  rol?: Rol;
}

/** Error con código HTTP, para que el manejador central sepa qué responder. */
export class ErrorHttp extends Error {
  readonly status: number;
  readonly codigo: string;

  constructor(status: number, mensaje: string, codigo = "error") {
    super(mensaje);
    this.name = "ErrorHttp";
    this.status = status;
    this.codigo = codigo;
  }
}
