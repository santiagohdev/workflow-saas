/* ============================================================================
   Cliente HTTP.

   Un único lugar donde se arma la petición, se adjunta el token y se traduce
   el error del backend a algo que se pueda mostrar. Repetir fetch por
   componente termina en manejos de error distintos en cada pantalla.
   ========================================================================== */

import type {
  Board,
  Columna,
  EventoStripeSugerido,
  Miembro,
  OrganizacionResumen,
  Prioridad,
  Rol,
  Tarea,
  Usuario,
  Uso,
} from "./tipos";

const BASE = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "http://localhost:4000/api";

const CLAVE_TOKEN = "workflow.token";

export const almacen = {
  leerToken: (): string | null => localStorage.getItem(CLAVE_TOKEN),
  guardarToken: (token: string): void => localStorage.setItem(CLAVE_TOKEN, token),
  borrarToken: (): void => localStorage.removeItem(CLAVE_TOKEN),
};

export class ErrorApi extends Error {
  readonly status: number;
  readonly codigo: string;
  constructor(status: number, mensaje: string, codigo: string) {
    super(mensaje);
    this.name = "ErrorApi";
    this.status = status;
    this.codigo = codigo;
  }
}

async function pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  const token = almacen.leerToken();
  const cabeceras = new Headers(opciones.headers);
  cabeceras.set("content-type", "application/json");
  if (token) cabeceras.set("authorization", `Bearer ${token}`);

  let respuesta: Response;
  try {
    respuesta = await fetch(`${BASE}${ruta}`, { ...opciones, headers: cabeceras });
  } catch {
    throw new ErrorApi(0, "No se pudo conectar con el servidor. ¿Está corriendo?", "sin_conexion");
  }

  const texto = await respuesta.text();
  const cuerpo: unknown = texto ? JSON.parse(texto) : {};

  if (!respuesta.ok) {
    const detalle = cuerpo as { error?: string; codigo?: string };
    /* Un 401 significa que el token venció o dejó de ser válido: se limpia
       para que la app vuelva al login en vez de reintentar en bucle. */
    if (respuesta.status === 401) almacen.borrarToken();
    throw new ErrorApi(
      respuesta.status,
      detalle.error ?? `Error ${respuesta.status}`,
      detalle.codigo ?? "error",
    );
  }

  return cuerpo as T;
}

interface RespuestaSesion {
  token: string;
  usuario: Usuario;
  organizaciones: OrganizacionResumen[];
}

export const api = {
  registrar: (datos: {
    email: string;
    password: string;
    name: string;
    organization_name: string;
  }) => pedir<RespuestaSesion>("/auth/register", { method: "POST", body: JSON.stringify(datos) }),

  entrar: (email: string, password: string) =>
    pedir<RespuestaSesion>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  sesion: () => pedir<{ usuario: Usuario; organizaciones: OrganizacionResumen[] }>("/auth/me"),

  uso: (orgId: string) => pedir<Uso>(`/organizations/${orgId}/usage`),

  miembros: (orgId: string) => pedir<{ miembros: Miembro[] }>(`/organizations/${orgId}/members`),

  agregarMiembro: (orgId: string, email: string, role: Rol) =>
    pedir<{ miembro: Miembro }>(`/organizations/${orgId}/members`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  quitarMiembro: (orgId: string, userId: string) =>
    pedir<{ ok: true }>(`/organizations/${orgId}/members/${userId}`, { method: "DELETE" }),

  tableros: (orgId: string) =>
    pedir<{ tableros: Board[] }>(`/boards?organization_id=${encodeURIComponent(orgId)}`),

  crearTablero: (orgId: string, name: string, description = "") =>
    pedir<{ tablero: Board }>("/boards", {
      method: "POST",
      body: JSON.stringify({ organization_id: orgId, name, description }),
    }),

  borrarTablero: (orgId: string, boardId: string) =>
    pedir<{ ok: true }>(`/boards/${boardId}?organization_id=${encodeURIComponent(orgId)}`, {
      method: "DELETE",
    }),

  tablero: (orgId: string, boardId: string) =>
    pedir<{ tablero: Board; columnas: Columna[]; tareas: Tarea[] }>(
      `/boards/${boardId}?organization_id=${encodeURIComponent(orgId)}`,
    ),

  crearColumna: (orgId: string, boardId: string, name: string) =>
    pedir<{ columna: Columna }>(`/boards/${boardId}/columns`, {
      method: "POST",
      body: JSON.stringify({ organization_id: orgId, name }),
    }),

  crearTarea: (
    orgId: string,
    boardId: string,
    datos: { title: string; column_id: string; priority?: Prioridad; description?: string },
  ) =>
    pedir<{ tarea: Tarea }>(`/boards/${boardId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ organization_id: orgId, ...datos }),
    }),

  actualizarTarea: (
    orgId: string,
    boardId: string,
    taskId: string,
    cambios: Partial<Pick<Tarea, "title" | "description" | "priority" | "column_id" | "position">>,
  ) =>
    pedir<{ tarea: Tarea }>(`/boards/${boardId}/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ organization_id: orgId, ...cambios }),
    }),

  borrarTarea: (orgId: string, boardId: string, taskId: string) =>
    pedir<{ ok: true }>(
      `/boards/${boardId}/tasks/${taskId}?organization_id=${encodeURIComponent(orgId)}`,
      { method: "DELETE" },
    ),

  checkout: (orgId: string) =>
    pedir<{ modo: string; stripe_customer_id: string; evento_sugerido: EventoStripeSugerido }>(
      `/billing/${orgId}/checkout`,
      { method: "POST", body: JSON.stringify({ organization_id: orgId }) },
    ),

  /* Solo en desarrollo. El backend firma el evento con su propio secreto y lo
     procesa por el mismo camino que un evento real: el panel nunca ve la
     credencial del webhook, que es como debe ser. */
  simularWebhook: (orgId: string, evento: EventoStripeSugerido) =>
    pedir<{ simulado: true; ok: boolean; tipo: string }>(`/billing/${orgId}/simular-webhook`, {
      method: "POST",
      body: JSON.stringify({ organization_id: orgId, evento }),
    }),

  cancelar: (orgId: string) =>
    pedir<{ modo: string; evento_sugerido: EventoStripeSugerido }>(`/billing/${orgId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ organization_id: orgId }),
    }),
};

export const BASE_API = BASE;
