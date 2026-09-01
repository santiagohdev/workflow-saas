/* ============================================================================
   Tableros, columnas y tareas.

   Toda consulta filtra por organization_id además del identificador del
   recurso. Puede parecer redundante —el tablero ya sabe a qué organización
   pertenece— pero es justamente lo que impide que un identificador filtrado o
   adivinado sirva para leer datos de otra empresa. El aislamiento se aplica
   en cada consulta, no una sola vez en la entrada.
   ========================================================================== */

import { Router, type Response } from "express";
import { ahora, consultarTodos, consultarUno, db, enTransaccion, uuid } from "../db/base.ts";
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

function siguientePosicion(tabla: "boards" | "columns" | "tasks", donde: string, valor: string): number {
  const columna = tabla === "boards" ? "organization_id" : tabla === "columns" ? "board_id" : "column_id";
  const fila = db
    .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS siguiente FROM ${tabla} WHERE ${columna} = ?`)
    .get(donde === columna ? valor : valor) as { siguiente: number } | undefined;
  return fila?.siguiente ?? 0;
}

/* ==========================================================================
   TABLEROS
   ========================================================================== */

/** GET /api/boards?organization_id=... */
rutasTableros.get("/", autenticar, requireRole("viewer"), (req: RequestAuth, res: Response, next) => {
  try {
    const org = req.organizacion!;
    const tableros = consultarTodos<Board>("SELECT * FROM boards WHERE organization_id = ? ORDER BY position, created_at", org.id);
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const cuerpo = req.body as Record<string, unknown>;
      const nombre = texto(cuerpo["name"], "el nombre del tablero", 120);
      const descripcion = opcional(cuerpo["description"], 500);

      const id = uuid();
      const momento = ahora();
      const posicion = siguientePosicion("boards", "organization_id", org.id);

      /* Un tablero vacío no sirve para nada: se crea con sus tres columnas
         en la misma transacción. */
      enTransaccion(() => {
        db.prepare(
          `INSERT INTO boards
             (id, organization_id, name, description, position, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, org.id, nombre, descripcion, posicion, req.usuario!.sub, momento, momento);

        COLUMNAS_INICIALES.forEach((nombreColumna, indice) => {
          db.prepare(
            `INSERT INTO columns (id, organization_id, board_id, name, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(uuid(), org.id, id, nombreColumna, indice, momento);
        });
      });

      const tablero = consultarUno<Board>("SELECT * FROM boards WHERE id = ?", id)!;
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;

      const tablero = consultarUno<Board>("SELECT * FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);

      if (!tablero) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      const columnas = consultarTodos<Columna>("SELECT * FROM columns WHERE board_id = ? AND organization_id = ? ORDER BY position", boardId, org.id);

      const tareas = consultarTodos<Tarea>("SELECT * FROM tasks WHERE board_id = ? AND organization_id = ? ORDER BY position", boardId, org.id);

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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const cuerpo = req.body as Record<string, unknown>;

      const actual = consultarUno<Board>("SELECT * FROM boards WHERE id = ? AND organization_id = ?", boardId, org.id);
      if (!actual) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      const nombre = cuerpo["name"] === undefined ? actual.name : texto(cuerpo["name"], "el nombre", 120);
      const descripcion =
        cuerpo["description"] === undefined ? actual.description : opcional(cuerpo["description"], 500);

      db.prepare(
        "UPDATE boards SET name = ?, description = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
      ).run(nombre, descripcion, ahora(), boardId, org.id);

      const tablero = consultarUno<Board>("SELECT * FROM boards WHERE id = ?", boardId)!;
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;

      const existe = db
        .prepare("SELECT 1 FROM boards WHERE id = ? AND organization_id = ?")
        .get(boardId, org.id);
      if (!existe) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      /* Las columnas y tareas se van solas por ON DELETE CASCADE. */
      db.prepare("DELETE FROM boards WHERE id = ? AND organization_id = ?").run(boardId, org.id);
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const nombre = texto((req.body as Record<string, unknown>)["name"], "el nombre de la columna", 80);

      const tablero = db
        .prepare("SELECT 1 FROM boards WHERE id = ? AND organization_id = ?")
        .get(boardId, org.id);
      if (!tablero) throw new ErrorHttp(404, "El tablero no existe.", "sin_tablero");

      const id = uuid();
      const posicion = siguientePosicion("columns", "board_id", boardId);

      db.prepare(
        `INSERT INTO columns (id, organization_id, board_id, name, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, org.id, boardId, nombre, posicion, ahora());

      const columna = consultarUno<Columna>("SELECT * FROM columns WHERE id = ?", id)!;
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const columnId = req.params["columnId"]!;
      const nombre = texto((req.body as Record<string, unknown>)["name"], "el nombre", 80);

      const resultado = db
        .prepare("UPDATE columns SET name = ? WHERE id = ? AND organization_id = ?")
        .run(nombre, columnId, org.id);

      if (resultado.changes === 0) throw new ErrorHttp(404, "La columna no existe.", "sin_columna");

      const columna = consultarUno<Columna>("SELECT * FROM columns WHERE id = ?", columnId)!;
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const columnId = req.params["columnId"]!;

      const resultado = db
        .prepare("DELETE FROM columns WHERE id = ? AND organization_id = ?")
        .run(columnId, org.id);

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
  (req: RequestAuth, res: Response, next) => {
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
      const columna = db
        .prepare("SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND organization_id = ?")
        .get(columnId, boardId, org.id);
      if (!columna) throw new ErrorHttp(404, "La columna no existe en este tablero.", "sin_columna");

      const asignado = typeof cuerpo["assignee_id"] === "string" ? cuerpo["assignee_id"] : null;
      if (asignado) {
        const esMiembro = db
          .prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?")
          .get(org.id, asignado);
        if (!esMiembro) {
          throw new ErrorHttp(400, "Solo se puede asignar a un miembro de la organización.", "no_miembro");
        }
      }

      const id = uuid();
      const momento = ahora();
      const posicion = siguientePosicion("tasks", "column_id", columnId);
      const vence = typeof cuerpo["due_date"] === "string" ? cuerpo["due_date"] : null;

      db.prepare(
        `INSERT INTO tasks
           (id, organization_id, board_id, column_id, title, description, priority,
            position, assignee_id, due_date, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, org.id, boardId, columnId, titulo, descripcion, prioridad,
        posicion, asignado, vence, req.usuario!.sub, momento, momento,
      );

      const tarea = consultarUno<Tarea>("SELECT * FROM tasks WHERE id = ?", id)!;
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const boardId = req.params["boardId"]!;
      const taskId = req.params["taskId"]!;
      const cuerpo = req.body as Record<string, unknown>;

      const actual = consultarUno<Tarea>("SELECT * FROM tasks WHERE id = ? AND board_id = ? AND organization_id = ?", taskId, boardId, org.id);
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
        const destino = db
          .prepare("SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND organization_id = ?")
          .get(cuerpo["column_id"], boardId, org.id);
        if (!destino) throw new ErrorHttp(404, "La columna de destino no existe.", "sin_columna");
        columnId = cuerpo["column_id"];
      }

      const posicion =
        typeof cuerpo["position"] === "number" && Number.isFinite(cuerpo["position"])
          ? Math.max(0, Math.trunc(cuerpo["position"]))
          : columnId === actual.column_id
            ? actual.position
            : siguientePosicion("tasks", "column_id", columnId);

      let asignado = actual.assignee_id;
      if ("assignee_id" in cuerpo) {
        const pedido = cuerpo["assignee_id"];
        if (pedido === null) {
          asignado = null;
        } else if (typeof pedido === "string") {
          const esMiembro = db
            .prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?")
            .get(org.id, pedido);
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

      db.prepare(
        `UPDATE tasks
            SET title = ?, description = ?, priority = ?, column_id = ?,
                position = ?, assignee_id = ?, due_date = ?, updated_at = ?
          WHERE id = ? AND organization_id = ?`,
      ).run(
        titulo, descripcion, prioridad, columnId, posicion, asignado, vence, ahora(), taskId, org.id,
      );

      const tarea = consultarUno<Tarea>("SELECT * FROM tasks WHERE id = ?", taskId)!;
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
  (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      const taskId = req.params["taskId"]!;

      const resultado = db
        .prepare("DELETE FROM tasks WHERE id = ? AND organization_id = ?")
        .run(taskId, org.id);

      if (resultado.changes === 0) throw new ErrorHttp(404, "La tarea no existe.", "sin_tarea");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
