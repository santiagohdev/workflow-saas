/* ============================================================================
   Tableros, columnas y tareas.

   Toda consulta filtra por organization_id además del identificador del
   recurso. Puede parecer redundante —el tablero ya sabe a qué organización
   pertenece— pero es justamente lo que impide que un identificador filtrado o
   adivinado sirva para leer datos de otra empresa. El aislamiento se aplica
   en cada consulta, no una sola vez en la entrada.
   ========================================================================== */

import { Router, type Response } from "express";
import { ahora, consultarTodos, consultarUno, ejecutar, enTransaccion, uuid } from "../db/base.ts";
import { autenticar } from "../middleware/autenticar.ts";
import { requireRole } from "../middleware/requireRole.ts";
import { checkPlanLimits } from "../middleware/checkPlanLimits.ts";
import {
  ErrorHttp,
  esUuid,
  type Board,
  type Columna,
  type Prioridad,
  type RequestAuth,
  type Tarea,
} from "../tipos.ts";

export const rutasTableros = Router();

const PRIORIDADES: readonly Prioridad[] = ["low", "medium", "high", "urgent"];
const COLUMNAS_INICIALES = ["Por hacer", "En curso", "Hecho"] as const;

/* Un identificador de la URL que no es uuid no puede existir: se responde
   404 antes de consultar, en vez de dejar que PostgreSQL falle por el tipo y
   salga un 500. */
const NO_EXISTE = {
  boardId: ["El tablero no existe.", "sin_tablero"],
  columnId: ["La columna no existe.", "sin_columna"],
  taskId: ["La tarea no existe.", "sin_tarea"],
} as const;

for (const [parametro, [mensaje, codigo]] of Object.entries(NO_EXISTE)) {
  rutasTableros.param(parametro, (_req, _res, next, valor: unknown) => {
    next(esUuid(valor) ? undefined : new ErrorHttp(404, mensaje, codigo));
  });
}

function texto(valor: unknown, campo: string, max = 200): string {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new ErrorHttp(400, `Falta ${campo}.`, "campo_faltante");
  }
  const limpio = valor.trim();
  if (limpio.length > max) {
    throw new ErrorHttp(400, `${campo} no puede superar ${max} caracteres.`, "campo_largo");
  }
  return limpio;
}

function opcional(valor: unknown, max = 2000): string {
  if (typeof valor !== "string") return "";
  return valor.trim().slice(0, max);
}

/* La fecha llega como texto y, sin validar, PostgreSQL la rechaza al guardar:
   el error salta en la base y sale como un 500, cuando el problema es del
   pedido. Se valida acá y se guarda normalizada en ISO.

   Además se controla que el día exista, porque JavaScript no rechaza las
   fechas imposibles: convierte el 30 de febrero en 1 de marzo sin avisar. */
function fechaOpcional(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === "") return null;

  const invalida = () =>
    new ErrorHttp(400, "La fecha de vencimiento no es válida. Usá el formato AAAA-MM-DD.", "fecha_invalida");

  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(valor)) throw invalida();

  const [anio, mes, dia] = valor.slice(0, 10).split("-").map(Number) as [number, number, number];
  const control = new Date(Date.UTC(anio, mes - 1, dia));
  if (control.getUTCMonth() !== mes - 1 || control.getUTCDate() !== dia) throw invalida();

  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime()) || anio < 1900 || fecha.getUTCFullYear() > 9999) {
    throw invalida();
  }
  return fecha.toISOString();
}

async function siguientePosicion(
  tabla: "boards" | "columns" | "tasks",
  donde: string,
  valor: string,
): Promise<number> {
  const columna = tabla === "boards" ? "organization_id" : tabla === "columns" ? "board_id" : "column_id";
  const fila = await consultarUno<{ siguiente: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS siguiente FROM ${tabla} WHERE ${columna} = ?`,
    donde === columna ? valor : valor,
  );
  return Number(fila?.siguiente ?? 0);
}

/* Deja la tarea en el lugar pedido de su columna —0 es arriba de todo— y
   renumera la columna entera: 0, 1, 2...

   Correr solo las tareas de abajo no alcanza: las posiciones tienen huecos,
   que quedan al borrar una tarea o al llevarla a otra columna, y entonces "el
   tercer lugar" y "position = 2" dejan de ser lo mismo. Sin lugar pedido, la
   tarea va al final.

   Es una sola consulta para toda la columna, no un viaje a la base por
   tarjeta. Tiene que correr dentro de la transacción del movimiento. */
async function ubicarEnColumna(
  taskId: string,
  columnId: string,
  orgId: string,
  lugar: number | null,
): Promise<void> {
  const resto = await consultarTodos<{ id: string }>(
    "SELECT id FROM tasks WHERE column_id = ? AND organization_id = ? AND id <> ? ORDER BY position, created_at",
    columnId, orgId, taskId,
  );

  const orden = resto.map((t) => t.id);
  orden.splice(Math.min(lugar ?? orden.length, orden.length), 0, taskId);

  await ejecutar(
    `UPDATE tasks AS t
        SET position = v.lugar - 1
       FROM jsonb_array_elements_text(?::jsonb) WITH ORDINALITY AS v(id, lugar)
      WHERE t.id = v.id::uuid AND t.organization_id = ?`,
    JSON.stringify(orden), orgId,
  );
}

/* ==========================================================================
   TABLEROS
   ========================================================================== */

/** GET /api/boards?organization_id=... */
rutasTableros.get("/", autenticar, requireRole("viewer"), async (req: RequestAuth, res: Response, next) => {
  try {
    const org = req.organizacion!;
    const tableros = await consultarTodos<Board>("SELECT * FROM boards WHERE organization_id = ? ORDER BY position, created_at", org.id);
    res.json({ tableros });
  } catch (error) {
    next(error);
  }
});

/** POST /api/boards — solo owner o admin, y sujeto al límite del plan. */
rutasTableros.post(
  "/",
  autenticar,
  requireRole("admin"),
  checkPlanLimits("boards"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const cuerpo = req.body as Record<string, unknown>;
      const nombre = texto(cuerpo["name"], "el nombre del tablero", 120);
      const descripcion = opcional(cuerpo["description"], 500);

      const id = uuid();
      const momento = ahora();
      const posicion = await siguientePosicion("boards", "organization_id", org.id);

      /* Un tablero vacío no sirve para nada: se crea con sus tres columnas
         en la misma transacción. */
      await enTransaccion(async () => {
        await ejecutar(
          `INSERT INTO boards
             (id, organization_id, name, description, position, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, org.id, nombre, descripcion, posicion, req.usuario!.sub, momento, momento,
        );

        /* for...of y no forEach: el callback de forEach no se espera, así que
           el COMMIT saldría antes de que se inserten las columnas. */
        let indice = 0;
        for (const nombreColumna of COLUMNAS_INICIALES) {
          await ejecutar(
            `INSERT INTO columns (id, organization_id, board_id, name, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            uuid(), org.id, id, nombreColumna, indice++, momento,
          );
        }
      });

      const tablero = (await consultarUno<Board>("SELECT * FROM boards WHERE id = ?", id))!;
      res.status(201).json({ tablero });
    } catch (error) {
      next(error);
    }
  },
);

/** GET /api/boards/:boardId — el tablero con sus columnas y tareas. */
rutasTableros.get(
  "/:boardId",
  autenticar,
  requireRole("viewer"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;

      const tablero = await consultarUno<Board>("SELECT * FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);

      if (!tablero) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      const columnas = await consultarTodos<Columna>("SELECT * FROM columns WHERE board_id = ? AND organization_id = ? ORDER BY position", boardId, org.id);

      const tareas = await consultarTodos<Tarea>("SELECT * FROM tasks WHERE board_id = ? AND organization_id = ? ORDER BY position, created_at", boardId, org.id);

      res.json({ tablero, columnas, tareas });
    } catch (error) {
      next(error);
    }
  },
);

/** PATCH /api/boards/:boardId */
rutasTableros.patch(
  "/:boardId",
  autenticar,
  requireRole("admin"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const cuerpo = req.body as Record<string, unknown>;

      const actual = await consultarUno<Board>("SELECT * FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);
      if (!actual) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      const nombre = cuerpo["name"] === undefined ? actual.name : texto(cuerpo["name"], "el nombre", 120);
      const descripcion =
        cuerpo["description"] === undefined ? actual.description : opcional(cuerpo["description"], 500);

      await ejecutar("UPDATE boards SET name = ?, description = ?, updated_at = ? WHERE id = ? AND organization_id = ?", nombre, descripcion, ahora(), boardId, org.id);

      const tablero = (await consultarUno<Board>("SELECT * FROM boards WHERE id = ?", boardId))!;
      res.json({ tablero });
    } catch (error) {
      next(error);
    }
  },
);

/** DELETE /api/boards/:boardId — solo el dueño. */
rutasTableros.delete(
  "/:boardId",
  autenticar,
  requireRole("owner"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;

      const existe = await consultarUno("SELECT 1 FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);
      if (!existe) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      /* Las columnas y tareas se van solas por ON DELETE CASCADE. */
      await ejecutar("DELETE FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

/* ==========================================================================
   COLUMNAS
   ========================================================================== */

/** POST /api/boards/:boardId/columns */
rutasTableros.post(
  "/:boardId/columns",
  autenticar,
  requireRole("member"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const nombre = texto((req.body as Record<string, unknown>)["name"], "el nombre de la columna", 80);

      const tablero = await consultarUno("SELECT 1 FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);
      if (!tablero) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      const id = uuid();
      const posicion = await siguientePosicion("columns", "board_id", boardId);

      await ejecutar(`INSERT INTO columns (id, organization_id, board_id, name, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`, id, org.id, boardId, nombre, posicion, ahora());

      const columna = (await consultarUno<Columna>("SELECT * FROM columns WHERE id = ?", id))!;
      res.status(201).json({ columna });
    } catch (error) {
      next(error);
    }
  },
);

/** PATCH /api/boards/:boardId/columns/:columnId */
rutasTableros.patch(
  "/:boardId/columns/:columnId",
  autenticar,
  requireRole("member"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const columnId = req.params["columnId"]!;
      const nombre = texto((req.body as Record<string, unknown>)["name"], "el nombre", 80);

      const resultado = await ejecutar("UPDATE columns SET name = ? WHERE id = ? AND organization_id = ?", nombre, columnId, org.id);

      if (resultado.changes === 0) throw new ErrorHttp(404, "La columna no existe.", "sin_columna");

      const columna = (await consultarUno<Columna>("SELECT * FROM columns WHERE id = ?", columnId))!;
      res.json({ columna });
    } catch (error) {
      next(error);
    }
  },
);

/** DELETE /api/boards/:boardId/columns/:columnId */
rutasTableros.delete(
  "/:boardId/columns/:columnId",
  autenticar,
  requireRole("admin"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const columnId = req.params["columnId"]!;

      const resultado = await ejecutar("DELETE FROM columns WHERE id = ? AND organization_id = ?", columnId, org.id);

      if (resultado.changes === 0) throw new ErrorHttp(404, "La columna no existe.", "sin_columna");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

/* ==========================================================================
   TAREAS
   ========================================================================== */

/** POST /api/boards/:boardId/tasks */
rutasTableros.post(
  "/:boardId/tasks",
  autenticar,
  requireRole("member"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const cuerpo = req.body as Record<string, unknown>;

      const titulo = texto(cuerpo["title"], "el título de la tarea", 200);
      const columnId = texto(cuerpo["column_id"], "la columna");
      const descripcion = opcional(cuerpo["description"]);

      const prioridad: Prioridad =
        typeof cuerpo["priority"] === "string" &&
        (PRIORIDADES as readonly string[]).includes(cuerpo["priority"])
          ? (cuerpo["priority"] as Prioridad)
          : "medium";

      /* La columna tiene que existir, pertenecer a este tablero y a esta
         organización. Las tres condiciones en la misma consulta. */
      const columna = esUuid(columnId)
        ? await consultarUno("SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND organization_id = ?", columnId, boardId, org.id)
        : undefined;
      if (!columna) throw new ErrorHttp(404, "La columna no existe en este tablero.", "sin_columna");

      const asignado = typeof cuerpo["assignee_id"] === "string" ? cuerpo["assignee_id"] : null;
      if (asignado) {
        const esMiembro =
          esUuid(asignado) &&
          (await consultarUno("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?", org.id, asignado));
        if (!esMiembro) {
          throw new ErrorHttp(400, "Solo se puede asignar a un miembro de la organización.", "no_miembro");
        }
      }

      const vence = fechaOpcional(cuerpo["due_date"]);

      const id = uuid();
      const momento = ahora();
      const posicion = await siguientePosicion("tasks", "column_id", columnId);

      await ejecutar(`INSERT INTO tasks
           (id, organization_id, board_id, column_id, title, description, priority,
            position, assignee_id, due_date, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        id, org.id, boardId, columnId, titulo, descripcion, prioridad,
        posicion, asignado, vence, req.usuario!.sub, momento, momento,
      );

      const tarea = (await consultarUno<Tarea>("SELECT * FROM tasks WHERE id = ?", id))!;
      res.status(201).json({ tarea });
    } catch (error) {
      next(error);
    }
  },
);

/** PATCH /api/boards/:boardId/tasks/:taskId — edita y también mueve.
    `position` es el lugar dentro de la columna de destino, contando desde 0. */
rutasTableros.patch(
  "/:boardId/tasks/:taskId",
  autenticar,
  requireRole("member"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const taskId = req.params["taskId"]!;
      const cuerpo = req.body as Record<string, unknown>;

      const actual = await consultarUno<Tarea>("SELECT * FROM tasks WHERE id = ? AND board_id = ? AND organization_id = ?", taskId, boardId, org.id);
      if (!actual) throw new ErrorHttp(404, "La tarea no existe.", "sin_tarea");

      const titulo = cuerpo["title"] === undefined ? actual.title : texto(cuerpo["title"], "el título", 200);
      const descripcion =
        cuerpo["description"] === undefined ? actual.description : opcional(cuerpo["description"]);

      const prioridad: Prioridad =
        typeof cuerpo["priority"] === "string" &&
        (PRIORIDADES as readonly string[]).includes(cuerpo["priority"])
          ? (cuerpo["priority"] as Prioridad)
          : actual.priority;

      let columnId = actual.column_id;
      if (typeof cuerpo["column_id"] === "string" && cuerpo["column_id"] !== actual.column_id) {
        const destino = esUuid(cuerpo["column_id"])
          ? await consultarUno("SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND organization_id = ?", cuerpo["column_id"], boardId, org.id)
          : undefined;
        if (!destino) throw new ErrorHttp(404, "La columna de destino no existe.", "sin_columna");
        columnId = cuerpo["column_id"];
      }

      /* El panel sabe en qué lugar soltaron la tarjeta, no qué valor de
         position tienen sus vecinas: por eso llega un lugar y no un número
         para guardar tal cual. */
      const lugar =
        typeof cuerpo["position"] === "number" && Number.isFinite(cuerpo["position"])
          ? Math.max(0, Math.trunc(cuerpo["position"]))
          : null;

      let asignado = actual.assignee_id;
      if ("assignee_id" in cuerpo) {
        const pedido = cuerpo["assignee_id"];
        if (pedido === null) {
          asignado = null;
        } else if (typeof pedido === "string") {
          const esMiembro =
            esUuid(pedido) &&
            (await consultarUno("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?", org.id, pedido));
          if (!esMiembro) {
            throw new ErrorHttp(400, "Solo se puede asignar a un miembro.", "no_miembro");
          }
          asignado = pedido;
        }
      }

      const vence = "due_date" in cuerpo ? fechaOpcional(cuerpo["due_date"]) : actual.due_date;

      /* La edición y el reordenamiento van juntos: si el segundo falla, la
         tarea no puede quedar cambiada de columna con una posición vieja. */
      await enTransaccion(async () => {
        await ejecutar(`UPDATE tasks
              SET title = ?, description = ?, priority = ?, column_id = ?,
                  assignee_id = ?, due_date = ?, updated_at = ?
            WHERE id = ? AND organization_id = ?`,
          titulo, descripcion, prioridad, columnId, asignado, vence, ahora(), taskId, org.id,
        );

        if (lugar !== null || columnId !== actual.column_id) {
          await ubicarEnColumna(taskId, columnId, org.id, lugar);
        }
      });

      const tarea = (await consultarUno<Tarea>("SELECT * FROM tasks WHERE id = ?", taskId))!;
      res.json({ tarea });
    } catch (error) {
      next(error);
    }
  },
);

/** DELETE /api/boards/:boardId/tasks/:taskId */
rutasTableros.delete(
  "/:boardId/tasks/:taskId",
  autenticar,
  requireRole("member"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const taskId = req.params["taskId"]!;

      const resultado = await ejecutar("DELETE FROM tasks WHERE id = ? AND organization_id = ?", taskId, org.id);

      if (resultado.changes === 0) throw new ErrorHttp(404, "La tarea no existe.", "sin_tarea");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
