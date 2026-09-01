export type Plan = "free" | "premium";
export type EstadoSuscripcion = "active" | "inactive";
export type Rol = "owner" | "admin" | "member" | "viewer";
export type Prioridad = "low" | "medium" | "high" | "urgent";

export const JERARQUIA: Readonly<Record<Rol, number>> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export interface Usuario {
  id: string;
  email: string;
  name: string;
}

export interface OrganizacionResumen {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  subscription_status: EstadoSuscripcion;
  role: Rol;
}

export interface Board {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  position: number;
  created_at: string;
}

export interface Columna {
  id: string;
  board_id: string;
  name: string;
  position: number;
}

export interface Tarea {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string;
  priority: Prioridad;
  position: number;
  assignee_id: string | null;
  due_date: string | null;
}

export interface Miembro {
  id: string;
  email: string;
  name: string;
  role: Rol;
  created_at: string;
}

export interface Uso {
  organizacion: {
    id: string;
    name: string;
    slug: string;
    plan: Plan;
    subscription_status: EstadoSuscripcion;
    plan_efectivo: Plan;
  };
  rol: Rol;
  uso: {
    boards: { usado: number; limite: number | null };
    members: { usado: number; limite: number | null };
  };
  limites_plan_gratis: { boards: number; members: number };
}

export interface EventoStripeSugerido {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}
