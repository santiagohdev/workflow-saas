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
  type Board,
  type Columna,
  type Prioridad,
  type RequestAuth,
  type Tarea,
} from "../tipos.ts";

export const rutasTableros = Router();

const PRIORIDADES: readonly Prioridad[] = ["low", "medium", "high", "urgent"];
const COLUMNAS_INICIALES = ["Por hacer", "En curso", "Hecho"] as const;

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

      const tareas = await consultarTodos<Tarea>("SELECT * FROM tasks WHERE board_id = ? AND organization_id = ? ORDER BY position", boardId, org.id);

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
      const columna = await consultarUno("SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND organization_id = ?", columnId, boardId, org.id);
      if (!columna) throw new ErrorHttp(404, "La columna no existe en este tablero.", "sin_columna");

      const asignado = typeof cuerpo["assignee_id"] === "string" ? cuerpo["assignee_id"] : null;
      if (asignado) {
        const esMiembro = await consultarUno("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?", org.id, asignado);
        if (!esMiembro) {
          throw new ErrorHttp(400, "Solo se puede asignar a un miembro de la organización.", "no_miembro");
        }
      }

      const id = uuid();
      const momento = ahora();
      const posicion = await siguientePosicion("tasks", "column_id", columnId);
      const vence = typeof cuerpo["due_date"] === "string" ? cuerpo["due_date"] : null;

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

/** PATCH /api/boards/:boardId/tasks/:taskId — edita y también mueve entre columnas. */
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
        const destino = await consultarUno("SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND organization_id = ?", cuerpo["column_id"], boardId, org.id);
        if (!destino) throw new ErrorHttp(404, "La columna de destino no existe.", "sin_columna");
        columnId = cuerpo["column_id"];
      }

      const posicion =
        typeof cuerpo["position"] === "number" && Number.isFinite(cuerpo["position"])
          ? Math.max(0, Math.trunc(cuerpo["position"]))
          : columnId === actual.column_id
            ? actual.position
            : await siguientePosicion("tasks", "column_id", columnId);

      let asignado = actual.assignee_id;
      if ("assignee_id" in cuerpo) {
        const pedido = cuerpo["assignee_id"];
        if (pedido === null) {
          asignado = null;
        } else if (typeof pedido === "string") {
          const esMiembro = await consultarUno("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?", org.id, pedido);
          if (!esMiembro) {
            throw new ErrorHttp(400, "Solo se puede asignar a un miembro.", "no_miembro");
          }
          asignado = pedido;
        }
      }

      const vence =
        "due_date" in cuerpo
          ? typeof cuerpo["due_date"] === "string"
            ? cuerpo["due_date"]
            : null
          : actual.due_date;

      await ejecutar(`UPDATE tasks
            SET title = ?, description = ?, priority = ?, column_id = ?,
                position = ?, assignee_id = ?, due_date = ?, updated_at = ?
          WHERE id = ? AND organization_id = ?`, 
        titulo, descripcion, prioridad, columnId, posicion, asignado, vence, ahora(), taskId, org.id,
      );

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
