-- SmartQueue normalized Supabase/Postgres schema
-- Assumes pgcrypto is available for gen_random_uuid()
create extension if not exists pgcrypto;

-- Optional helper for timestamp updates
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text not null,
  address text not null,
  phone text not null default '',
  email text not null default '',
  category text not null default 'other',
  status text not null default 'operational',
  subscription_status text not null default 'active',
  subscription_end_date timestamptz null,
  trial_end_date timestamptz null,
  max_capacity integer not null default 150,
  operating_hours jsonb not null default '[]'::jsonb,
  notifications jsonb not null default '{}'::jsonb,
  billing_details jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete restrict,
  name text not null,
  description text null,
  duration integer not null default 10,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, name)
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password text not null,
  phone text not null default '',
  role text not null default 'customer',
  branch uuid null references branches(id) on delete set null,
  notify_channel text not null default 'email',
  status text not null default 'active',
  trial_active boolean not null default false,
  trial_started_at timestamptz null,
  trial_ends_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists counters (
  id uuid primary key default gen_random_uuid(),
  branch uuid not null references branches(id) on delete restrict,
  name text not null,
  agent uuid null references users(id) on delete set null,
  status text not null default 'active',
  serving uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists queues (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique,
  branch uuid not null references branches(id) on delete restrict,
  user uuid null references users(id) on delete set null,
  name text not null,
  email text not null default '',
  phone text not null default '',
  notify_channel text not null default 'email',
  service jsonb not null,
  time_slot text not null default 'As soon as possible',
  status text not null default 'waiting',
  position integer not null default 1,
  estimated_wait integer not null default 0,
  qr_code text null,
  counter uuid null references counters(id) on delete set null,
  called_at timestamptz null,
  served_at timestamptz null,
  no_show_at timestamptz null,
  rating integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null references users(id) on delete set null,
  ticket_id uuid null references queues(id) on delete set null,
  type text not null default 'info',
  title text not null,
  message text not null,
  channel text not null default 'email',
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_services_branch_id on services(branch_id);
create index if not exists idx_users_branch on users(branch);
create index if not exists idx_counters_branch on counters(branch);
create index if not exists idx_queues_branch on queues(branch);
create index if not exists idx_queues_user on queues(user);
create index if not exists idx_notifications_user_id on notifications(user_id);

drop trigger if exists trg_branches_updated_at on branches;
create trigger trg_branches_updated_at
before update on branches
for each row execute function set_updated_at();

drop trigger if exists trg_services_updated_at on services;
create trigger trg_services_updated_at
before update on services
for each row execute function set_updated_at();

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
before update on users
for each row execute function set_updated_at();

drop trigger if exists trg_counters_updated_at on counters;
create trigger trg_counters_updated_at
before update on counters
for each row execute function set_updated_at();

drop trigger if exists trg_queues_updated_at on queues;
create trigger trg_queues_updated_at
before update on queues
for each row execute function set_updated_at();

drop trigger if exists trg_notifications_updated_at on notifications;
create trigger trg_notifications_updated_at
before update on notifications
for each row execute function set_updated_at();
