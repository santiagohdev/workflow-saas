/* ============================================================================
   Capa de acceso a datos.

   Corre sobre SQLite, que viene incluido en Node y no necesita instalar nada:
   el proyecto arranca con un npm install y cero servicios externos. El
   esquema es el mismo que el de sql/001_supabase.sql, de modo que migrar a
   PostgreSQL es reemplazar este archivo y no tocar el resto del sistema.

   El resto de la aplicación no importa `db` directamente: habla contra las
   funciones de este módulo. Esa frontera es lo que hace que el cambio de
   motor sea barato.
   ========================================================================== */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.ts";

const RUTA = resolve(process.cwd(), config.baseDatos);
mkdirSync(dirname(RUTA), { recursive: true });

export const db = new DatabaseSync(RUTA);

/* WAL permite leer mientras se escribe. Sin esto, dos peticiones simultáneas
   se bloquean entre sí. */
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

export const uuid = (): string => randomUUID();
export const ahora = (): string => new Date().toISOString();

/* ---------------------------------------------------------------------------
   Frontera tipada entre SQL y el dominio.

   El driver devuelve Record<string, SQLOutputValue>: no puede saber la forma
   de cada consulta. Convertir eso a un tipo del dominio es una afirmación
   nuestra, y estas dos funciones son el único lugar donde se hace. Tenerlas
   concentradas acá significa que hay exactamente dos líneas para auditar
   cuando el esquema cambie, en vez de una por consulta desparramada.
   -------------------------------------------------------------------------- */

export function consultarUno<T>(sql: string, ...parametros: SQLParam[]): T | undefined {
  return db.prepare(sql).get(...parametros) as T | undefined;
}

export function consultarTodos<T>(sql: string, ...parametros: SQLParam[]): T[] {
  return db.prepare(sql).all(...parametros) as T[];
}

export function ejecutar(sql: string, ...parametros: SQLParam[]): { changes: number } {
  const resultado = db.prepare(sql).run(...parametros);
  return { changes: Number(resultado.changes) };
}

type SQLParam = string | number | bigint | null | Uint8Array;

/** Ejecuta varias sentencias como una unidad. Si algo falla, no queda a medias. */
export function enTransaccion<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const salida = fn();
    db.exec("COMMIT");
    return salida;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrar(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      slug                TEXT NOT NULL UNIQUE,
      plan                TEXT NOT NULL DEFAULT 'free'
                          CHECK (plan IN ('free','premium')),
      subscription_status TEXT NOT NULL DEFAULT 'inactive'
                          CHECK (subscription_status IN ('active','inactive')),
      stripe_customer_id  TEXT UNIQUE,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_org_stripe_customer
      ON organizations (stripe_customer_id);

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organization_members (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
      role            TEXT NOT NULL DEFAULT 'member'
                      CHECK (role IN ('owner','admin','member','viewer')),
      created_at      TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members (user_id);
    CREATE INDEX IF NOT EXISTS idx_members_org  ON organization_members (organization_id);

    CREATE TABLE IF NOT EXISTS boards (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      position        INTEGER NOT NULL DEFAULT 0,
      created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_boards_org ON boards (organization_id, position);

    CREATE TABLE IF NOT EXISTS columns (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      board_id        TEXT NOT NULL REFERENCES boards(id)        ON DELETE CASCADE,
      name            TEXT NOT NULL,
      position        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_columns_board ON columns (board_id, position);
    CREATE INDEX IF NOT EXISTS idx_columns_org   ON columns (organization_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      board_id        TEXT NOT NULL REFERENCES boards(id)        ON DELETE CASCADE,
      column_id       TEXT NOT NULL REFERENCES columns(id)       ON DELETE CASCADE,
      title           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      priority        TEXT NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('low','medium','high','urgent')),
      position        INTEGER NOT NULL DEFAULT 0,
      assignee_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      due_date        TEXT,
      created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks (column_id, position);
    CREATE INDEX IF NOT EXISTS idx_tasks_board  ON tasks (board_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_org    ON tasks (organization_id);
  `);
}
