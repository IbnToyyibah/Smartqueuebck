-- SmartQueue Supabase schema
-- Paste into Supabase SQL Editor on a clean database, or run table-by-table.
-- This schema is inferred from the app code.

create extension if not exists "pgcrypto";

create table if not exists public.branches (
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

create table if not exists public.users (
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

create table if not exists public.services (
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

create table if not exists public.counters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  branch uuid not null references public.branches (id) on delete cascade,
  agent uuid null references public.users (id) on delete set null,
  serving uuid null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.queues (
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

create table if not exists public.notifications (
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
create index if not exists queues_user_idx on public.queues (user);
create index if not exists queues_status_idx on public.queues (status);
create index if not exists queues_created_at_idx on public.queues (created_at);
create index if not exists notifications_user_idx on public.notifications (user);
create index if not exists notifications_read_idx on public.notifications (read);
create index if not exists notifications_created_at_idx on public.notifications (created_at);

