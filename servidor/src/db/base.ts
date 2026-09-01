/* ============================================================================
   Capa de acceso a datos.

   Corre sobre PostgreSQL. El resto de la aplicación no toca el driver: habla
   contra las cuatro funciones de este módulo. Esa frontera es lo que permitió
   cambiar de motor sin reescribir las rutas, y por eso este archivo ya no
   exporta el cliente: si vuelve a filtrarse, el próximo cambio deja de ser
   barato.

   Dos traducciones ocurren acá y en ningún otro lado:

   1. Los parámetros se escriben `?` como en SQLite y se convierten a `$1, $2`
      antes de salir. Así las consultas de las rutas quedaron intactas.

   2. Las marcas de tiempo vuelven como texto ISO, no como Date. El panel ya
      esperaba texto; que el driver devuelva objetos cambiaría el JSON de
      todas las respuestas.
   ========================================================================== */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { config } from "../config.ts";

const { Pool, types } = pg;

/* --- timestamptz y timestamp como texto ISO, no como Date. --- */
const OID_TIMESTAMPTZ = 1184;
const OID_TIMESTAMP = 1114;
const aISO = (valor: string | null): string | null =>
  valor === null ? null : new Date(valor).toISOString();
types.setTypeParser(OID_TIMESTAMPTZ, aISO);
types.setTypeParser(OID_TIMESTAMP, aISO);

/* Supabase exige TLS. Su certificado lo firma una CA propia que no está en el
   almacén de Node, así que verificarlo contra el almacén del sistema falla.
   La conexión sigue cifrada. En local (localhost) no hay TLS que negociar. */
const esLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: esLocal ? false : { rejectUnauthorized: false },
  max: config.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/* Un error en una conexión ociosa no debe tumbar el proceso. */
pool.on("error", (error) => {
  console.error("error en conexión ociosa del pool:", error);
});

export const uuid = (): string => randomUUID();
export const ahora = (): string => new Date().toISOString();

export type SQLParam = string | number | boolean | null;

/* ---------------------------------------------------------------------------
   `?` → `$1, $2, ...`

   Se recorre carácter por carácter en vez de usar un reemplazo global porque
   un `?` dentro de una cadena literal no es un parámetro. Hoy ninguna consulta
   tiene uno; el día que aparezca, esto ya lo contempla.
   -------------------------------------------------------------------------- */
function traducir(sql: string): string {
  let salida = "";
  let n = 0;
  let enCadena = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (c === "'") {
      // '' dentro de una cadena es una comilla escapada, no el cierre.
      if (enCadena && sql[i + 1] === "'") {
        salida += "''";
        i++;
        continue;
      }
      enCadena = !enCadena;
      salida += c;
      continue;
    }

    if (c === "?" && !enCadena) {
      salida += `$${++n}`;
      continue;
    }

    salida += c;
  }

  return salida;
}

/* ---------------------------------------------------------------------------
   Transacciones.

   El problema: dentro de `enTransaccion` las rutas siguen llamando a
   `consultarUno` y `ejecutar` sin recibir ningún cliente. Si cada una toma una
   conexión distinta del pool, quedan fuera de la transacción y el ROLLBACK no
   deshace nada: exactamente el bug que la transacción venía a evitar.

   AsyncLocalStorage ata el cliente al contexto asíncrono, de modo que toda
   consulta lanzada dentro del callback lo encuentra sola.
   -------------------------------------------------------------------------- */
const contexto = new AsyncLocalStorage<pg.PoolClient>();

async function correr(sql: string, parametros: SQLParam[]): Promise<pg.QueryResult> {
  const cliente = contexto.getStore();
  if (cliente) return cliente.query(traducir(sql), parametros);
  return pool.query(traducir(sql), parametros);
}

/* ---------------------------------------------------------------------------
   Frontera tipada entre SQL y el dominio.

   El driver devuelve filas sin forma conocida: no puede saber la de cada
   consulta. Convertir eso a un tipo del dominio es una afirmación nuestra, y
   estas funciones son el único lugar donde se hace.
   -------------------------------------------------------------------------- */

export async function consultarUno<T>(
  sql: string,
  ...parametros: SQLParam[]
): Promise<T | undefined> {
  const { rows } = await correr(sql, parametros);
  return rows[0] as T | undefined;
}

export async function consultarTodos<T>(sql: string, ...parametros: SQLParam[]): Promise<T[]> {
  const { rows } = await correr(sql, parametros);
  return rows as T[];
}

export async function ejecutar(
  sql: string,
  ...parametros: SQLParam[]
): Promise<{ changes: number }> {
  const resultado = await correr(sql, parametros);
  return { changes: resultado.rowCount ?? 0 };
}

/** Ejecuta varias sentencias como una unidad. Si algo falla, no queda a medias. */
export async function enTransaccion<T>(fn: () => Promise<T>): Promise<T> {
  /* Anidar transacciones abriría una segunda conexión y rompería la atomicidad
     de la primera. Si ya estamos dentro de una, se reutiliza. */
  if (contexto.getStore()) return fn();

  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const salida = await contexto.run(cliente, fn);
    await cliente.query("COMMIT");
    return salida;
  } catch (error) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

/** Cierra el pool. Sin esto, el proceso no termina al recibir SIGTERM. */
export async function cerrar(): Promise<void> {
  await pool.end();
}

/* ---------------------------------------------------------------------------
   Esquema.

   Es el mismo de sql/001_supabase.sql, sin las políticas de RLS ni los
   disparadores, que se aplican una vez desde el editor de Supabase. Correrlo
   al arrancar deja una base vacía lista sin pasos manuales, y sobre una que
   ya existe no hace nada.
   -------------------------------------------------------------------------- */
export async function migrar(): Promise<void> {
  await ejecutar(`create extension if not exists pgcrypto`);

  await ejecutar(`
    create table if not exists organizations (
      id                  uuid primary key default gen_random_uuid(),
      name                text        not null,
      slug                text        not null unique,
      plan                text        not null default 'free'
                          check (plan in ('free','premium')),
      subscription_status text        not null default 'inactive'
                          check (subscription_status in ('active','inactive')),
      stripe_customer_id  text unique,
      created_at          timestamptz not null default now(),
      updated_at          timestamptz not null default now()
    )`);

  await ejecutar(`
    create index if not exists idx_org_stripe_customer
      on organizations (stripe_customer_id)`);

  await ejecutar(`
    create table if not exists users (
      id            uuid primary key default gen_random_uuid(),
      email         text        not null unique,
      name          text        not null default '',
      password_hash text        not null,
      created_at    timestamptz not null default now()
    )`);

  await ejecutar(`
    create table if not exists organization_members (
      organization_id uuid        not null references organizations(id) on delete cascade,
      user_id         uuid        not null references users(id)         on delete cascade,
      role            text        not null default 'member'
                      check (role in ('owner','admin','member','viewer')),
      created_at      timestamptz not null default now(),
      primary key (organization_id, user_id)
    )`);

  await ejecutar(`create index if not exists idx_members_user on organization_members (user_id)`);
  await ejecutar(`create index if not exists idx_members_org on organization_members (organization_id)`);

  await ejecutar(`
    create table if not exists boards (
      id              uuid primary key default gen_random_uuid(),
      organization_id uuid        not null references organizations(id) on delete cascade,
      name            text        not null,
      description     text        not null default '',
      position        integer     not null default 0,
      created_by      uuid        references users(id) on delete set null,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )`);

  await ejecutar(`create index if not exists idx_boards_org on boards (organization_id, position)`);

  await ejecutar(`
    create table if not exists columns (
      id              uuid primary key default gen_random_uuid(),
      organization_id uuid        not null references organizations(id) on delete cascade,
      board_id        uuid        not null references boards(id)        on delete cascade,
      name            text        not null,
      position        integer     not null default 0,
      created_at      timestamptz not null default now()
    )`);

  await ejecutar(`create index if not exists idx_columns_board on columns (board_id, position)`);
  await ejecutar(`create index if not exists idx_columns_org on columns (organization_id)`);

  await ejecutar(`
    create table if not exists tasks (
      id              uuid primary key default gen_random_uuid(),
      organization_id uuid        not null references organizations(id) on delete cascade,
      board_id        uuid        not null references boards(id)        on delete cascade,
      column_id       uuid        not null references columns(id)       on delete cascade,
      title           text        not null,
      description     text        not null default '',
      priority        text        not null default 'medium'
                      check (priority in ('low','medium','high','urgent')),
      position        integer     not null default 0,
      assignee_id     uuid        references users(id) on delete set null,
      due_date        timestamptz,
      created_by      uuid        references users(id) on delete set null,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )`);

  await ejecutar(`create index if not exists idx_tasks_column on tasks (column_id, position)`);
  await ejecutar(`create index if not exists idx_tasks_board on tasks (board_id)`);
  await ejecutar(`create index if not exists idx_tasks_org on tasks (organization_id)`);
}
