-- SmartQueue Supabase schema patch for an existing database
-- Safe to paste into Supabase SQL Editor on a live DB.

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'branches') then
    create table public.branches (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      city text not null,
      address text not null,
      phone text not null default '',
      email text not null default '',
      category text not null default 'other',
      status text not null default 'operational',
      max_capacity integer not null default 150,
      subscription_status text not null default 'active',
      subscription_end_date timestamptz null,
      trial_end_date timestamptz null,
      operating_hours jsonb not null default '[]'::jsonb,
      notifications jsonb null,
      billing_details jsonb null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'users') then
    create table public.users (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      email text not null unique,
      password text not null,
      phone text not null default '',
      role text not null default 'customer',
      branch uuid null references public.branches (id) on delete set null,
      notify_channel text not null default 'email',
      status text not null default 'active',
      trial_active boolean not null default false,
      trial_started_at timestamptz null,
      trial_ends_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'services') then
    create table public.services (
      id uuid primary key default gen_random_uuid(),
      branch_id uuid not null references public.branches (id) on delete cascade,
      name text not null,
      description text not null default '',
      duration integer not null default 10,
      is_active boolean not null default true,
      sort_order integer not null default 0,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'counters') then
    create table public.counters (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      branch uuid not null references public.branches (id) on delete cascade,
      agent uuid null references public.users (id) on delete set null,
      serving uuid null,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'queues') then
    create table public.queues (
      id uuid primary key default gen_random_uuid(),
      ticket_number text not null unique,
      branch uuid not null references public.branches (id) on delete cascade,
      user uuid null references public.users (id) on delete set null,
      counter uuid null references public.counters (id) on delete set null,
      name text not null,
      email text not null default '',
      phone text not null default '',
      notify_channel text not null default 'email',
      service jsonb not null default '{}'::jsonb,
      time_slot text not null default 'As soon as possible',
      status text not null default 'waiting',
      position integer not null default 1,
      estimated_wait integer not null default 10,
      qr_code text null,
      called_at timestamptz null,
      served_at timestamptz null,
      no_show_at timestamptz null,
      rating integer null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'notifications') then
    create table public.notifications (
      id uuid primary key default gen_random_uuid(),
      user uuid null references public.users (id) on delete set null,
      ticket uuid null references public.queues (id) on delete set null,
      type text not null default 'info',
      title text not null,
      message text not null,
      channel text not null default 'email',
      read boolean not null default false,
      channels jsonb null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

alter table public.branches
  add column if not exists name text,
  add column if not exists city text,
  add column if not exists address text,
  add column if not exists phone text default '',
  add column if not exists email text default '',
  add column if not exists category text default 'other',
  add column if not exists status text default 'operational',
  add column if not exists max_capacity integer default 150,
  add column if not exists subscription_status text default 'active',
  add column if not exists subscription_end_date timestamptz,
  add column if not exists trial_end_date timestamptz,
  add column if not exists operating_hours jsonb default '[]'::jsonb,
  add column if not exists notifications jsonb,
  add column if not exists billing_details jsonb,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.users
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists password text,
  add column if not exists phone text default '',
  add column if not exists role text default 'customer',
  add column if not exists branch uuid,
  add column if not exists notify_channel text default 'email',
  add column if not exists status text default 'active',
  add column if not exists trial_active boolean default false,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.services
  add column if not exists branch_id uuid,
  add column if not exists name text,
  add column if not exists description text default '',
  add column if not exists duration integer default 10,
  add column if not exists is_active boolean default true,
  add column if not exists sort_order integer default 0,
  add column if not exists meta jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.counters
  add column if not exists name text,
  add column if not exists branch uuid,
  add column if not exists agent uuid,
  add column if not exists serving uuid,
  add column if not exists status text default 'active',
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.queues
  add column if not exists ticket_number text,
  add column if not exists branch uuid,
  add column if not exists "user" uuid,
  add column if not exists counter uuid,
  add column if not exists name text,
  add column if not exists email text default '',
  add column if not exists phone text default '',
  add column if not exists notify_channel text default 'email',
  add column if not exists service jsonb default '{}'::jsonb,
  add column if not exists time_slot text default 'As soon as possible',
  add column if not exists status text default 'waiting',
  add column if not exists position integer default 1,
  add column if not exists estimated_wait integer default 10,
  add column if not exists qr_code text,
  add column if not exists called_at timestamptz,
  add column if not exists served_at timestamptz,
  add column if not exists no_show_at timestamptz,
  add column if not exists rating integer,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.notifications
  add column if not exists "user" uuid,
  add column if not exists ticket uuid,
  add column if not exists type text default 'info',
  add column if not exists title text,
  add column if not exists message text,
  add column if not exists channel text default 'email',
  add column if not exists read boolean default false,
  add column if not exists channels jsonb,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.services
set duration = 10
where duration is null;

alter table public.services
  alter column duration set default 10,
  alter column duration set not null;

create index if not exists branches_status_idx on public.branches (status);
create index if not exists branches_subscription_status_idx on public.branches (subscription_status);
create index if not exists users_email_idx on public.users (email);
create index if not exists users_role_idx on public.users (role);
create index if not exists users_branch_idx on public.users (branch);
create index if not exists services_branch_id_idx on public.services (branch_id);
create index if not exists services_active_idx on public.services (is_active);
create index if not exists counters_branch_idx on public.counters (branch);
create index if not exists counters_agent_idx on public.counters (agent);
create index if not exists queues_branch_idx on public.queues (branch);
create index if not exists queues_user_idx on public.queues ("user");
create index if not exists queues_status_idx on public.queues (status);
create index if not exists queues_created_at_idx on public.queues (created_at);
create index if not exists notifications_user_idx on public.notifications ("user");
create index if not exists notifications_read_idx on public.notifications (read);
create index if not exists notifications_created_at_idx on public.notifications (created_at);

