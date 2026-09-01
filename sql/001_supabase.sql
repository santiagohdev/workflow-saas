-- =============================================================================
-- Multi-Tenant Enterprise Workflow and Task Management SaaS
-- Esquema PostgreSQL para Supabase.
--
-- Ejecutar completo en el SQL Editor. Es idempotente.
--
-- Regla de oro del esquema: toda tabla de contenido lleva organization_id.
-- No se llega a una tarea desde una columna desde un tablero: se filtra por
-- organización en cada consulta. Un join de más es barato; una fuga de datos
-- entre empresas, no.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- organizations — los inquilinos
-- -----------------------------------------------------------------------------
create table if not exists public.organizations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text        not null,
  slug                 text        not null unique,
  plan                 text        not null default 'free'
                       check (plan in ('free','premium')),
  subscription_status  text        not null default 'inactive'
                       check (subscription_status in ('active','inactive')),
  stripe_customer_id   text unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_org_stripe_customer
  on public.organizations (stripe_customer_id);

-- -----------------------------------------------------------------------------
-- users — cuentas, independientes de la organización
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null unique,
  name          text        not null default '',
  password_hash text        not null,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- organization_members — la tabla que hace posible el multi-tenant real.
--
-- Una persona puede pertenecer a varias organizaciones con un rol distinto en
-- cada una. Por eso el rol vive acá y no en users.
-- -----------------------------------------------------------------------------
create table if not exists public.organization_members (
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  user_id         uuid        not null references public.users(id)         on delete cascade,
  role            text        not null default 'member'
                  check (role in ('owner','admin','member','viewer')),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists idx_members_user on public.organization_members (user_id);
create index if not exists idx_members_org  on public.organization_members (organization_id);

-- -----------------------------------------------------------------------------
-- boards
-- -----------------------------------------------------------------------------
create table if not exists public.boards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  name            text        not null,
  description     text        not null default '',
  position        integer     not null default 0,
  created_by      uuid        references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_boards_org on public.boards (organization_id, position);

-- -----------------------------------------------------------------------------
-- columns
-- -----------------------------------------------------------------------------
create table if not exists public.columns (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  board_id        uuid        not null references public.boards(id)        on delete cascade,
  name            text        not null,
  position        integer     not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists idx_columns_board on public.columns (board_id, position);
create index if not exists idx_columns_org   on public.columns (organization_id);

-- -----------------------------------------------------------------------------
-- tasks
-- -----------------------------------------------------------------------------
create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  board_id        uuid        not null references public.boards(id)        on delete cascade,
  column_id       uuid        not null references public.columns(id)       on delete cascade,
  title           text        not null,
  description     text        not null default '',
  priority        text        not null default 'medium'
                  check (priority in ('low','medium','high','urgent')),
  position        integer     not null default 0,
  assignee_id     uuid        references public.users(id) on delete set null,
  due_date        timestamptz,
  created_by      uuid        references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tasks_column on public.tasks (column_id, position);
create index if not exists idx_tasks_board  on public.tasks (board_id);
create index if not exists idx_tasks_org    on public.tasks (organization_id);

-- -----------------------------------------------------------------------------
-- updated_at automático
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_org_updated    on public.organizations;
drop trigger if exists trg_boards_updated on public.boards;
drop trigger if exists trg_tasks_updated  on public.tasks;

create trigger trg_org_updated    before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger trg_boards_updated before update on public.boards
  for each row execute function public.touch_updated_at();
create trigger trg_tasks_updated  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- El backend usa la service role key y no pasa por RLS: el aislamiento lo
-- impone la aplicación en cada consulta. Estas políticas cierran la puerta a
-- que la anon key exponga datos si alguien consulta desde el navegador.
-- -----------------------------------------------------------------------------
alter table public.organizations        enable row level security;
alter table public.users                enable row level security;
alter table public.organization_members enable row level security;
alter table public.boards               enable row level security;
alter table public.columns              enable row level security;
alter table public.tasks                enable row level security;

do $$
declare t text;
begin
  foreach t in array array['organizations','users','organization_members','boards','columns','tasks']
  loop
    execute format('drop policy if exists "sin acceso directo" on public.%I', t);
    execute format('create policy "sin acceso directo" on public.%I for all to anon, authenticated using (false)', t);
  end loop;
end $$;
