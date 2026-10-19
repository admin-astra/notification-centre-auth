-- =============================================================================
-- Team-scoped access: Astra, Clear Nexus, Credit Deployment
-- =============================================================================
-- Applied to the "CDS Extension" Supabase project (mfixofximhpmixdkyggb).
--
-- authorized_users  = extension users (log in to the extension with an OTP)
-- dashboard_users   = web-dashboard logins (Supabase Auth email + password)
--
-- What each dashboard login can do:
--   can_manage_org  -> see + issue OTPs + sign out everyone in its own team
--   can_view_all    -> see every team's users (read-only outside its own scope)
--   always          -> issue an OTP for / sign out ITSELF, if it is also an
--                      extension user (same email in authorized_users)
--
-- The extension's own RPCs (verify_otp, session_ping) are unchanged.
-- =============================================================================

-- 1. Extension users belong to a team and have a role -------------------------
alter table public.authorized_users
  add column if not exists org  text not null default 'astra',
  add column if not exists role text not null default 'agent';

alter table public.authorized_users
  add constraint authorized_users_org_check  check (org  in ('astra', 'clear_nexus', 'credit_deployment')),
  add constraint authorized_users_role_check check (role in ('agent', 'supervisor'));

-- 2. Web-dashboard logins and what each one can see / do ----------------------
create table public.dashboard_users (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  org            text not null check (org in ('astra', 'clear_nexus', 'credit_deployment')),
  can_view_all   boolean not null default false,
  can_manage_org boolean not null default false,
  created_at     timestamptz not null default now()
);
alter table public.dashboard_users enable row level security;
create policy dash_users_self on public.dashboard_users
  for select to authenticated using (user_id = (select auth.uid()));

-- 3. Permission helpers --------------------------------------------------------
create or replace function public.dash_can_view(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.dashboard_users d
      join auth.users u on u.id = d.user_id
      left join public.authorized_users a on lower(a.email) = lower(trim(p_email))
     where d.user_id = auth.uid()
       and (d.can_view_all
            or lower(u.email) = lower(trim(p_email))
            or a.org = d.org)
  );
$$;

create or replace function public.dash_can_manage(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.dashboard_users d
      join auth.users u on u.id = d.user_id
      join public.authorized_users a on lower(a.email) = lower(trim(p_email))
     where d.user_id = auth.uid()
       and (lower(a.email) = lower(u.email)
            or (d.can_manage_org and a.org = d.org))
  );
$$;

-- 4. Row-level security: replaces the old "any signed-in manager sees all" -----
drop policy if exists mgr_select_users on public.authorized_users;
drop policy if exists mgr_modify_users on public.authorized_users;
create policy dash_select_users on public.authorized_users
  for select to authenticated using (public.dash_can_view(email));

drop policy if exists mgr_select_sess on public.access_sessions;
drop policy if exists mgr_modify_sess on public.access_sessions;
create policy dash_select_sess on public.access_sessions
  for select to authenticated using (public.dash_can_manage(email));
create policy dash_insert_sess on public.access_sessions
  for insert to authenticated with check (public.dash_can_manage(email));
create policy dash_delete_sess on public.access_sessions
  for delete to authenticated using (public.dash_can_manage(email));

-- 5. Dashboard RPCs ------------------------------------------------------------
create or replace function public.dashboard_me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
           'email',          u.email,
           'org',            d.org,
           'can_view_all',   d.can_view_all,
           'can_manage_org', d.can_manage_org,
           'display_name',   a.display_name)
    from public.dashboard_users d
    join auth.users u on u.id = d.user_id
    left join public.authorized_users a on lower(a.email) = lower(u.email)
   where d.user_id = auth.uid();
$$;

-- One row per extension user the caller may see. No OTP codes leave here.
create or replace function public.dashboard_roster()
returns table (
  email        text,
  display_name text,
  org          text,
  role         text,
  is_active    boolean,
  last_ping    timestamptz,
  has_session  boolean,
  can_manage   boolean
)
language sql stable security definer set search_path = ''
as $$
  select a.email, a.display_name, a.org, a.role, a.is_active,
         s.last_ping, s.n > 0, public.dash_can_manage(a.email)
    from public.authorized_users a
    cross join lateral (
      select max(x.last_ping) as last_ping, count(*) as n
        from public.access_sessions x
       where lower(x.email) = lower(a.email)
         and x.expires_at > now()
    ) s
   where public.dash_can_view(a.email);
$$;

-- OTP is generated server-side, and only for a user the caller may manage.
create or replace function public.generate_otp(p_email text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_email   text;
  v_rand    bigint;
  v_otp     text;
  v_expires timestamptz := now() + interval '12 hours';
begin
  if not public.dash_can_manage(p_email) then
    return jsonb_build_object('ok', false, 'error', 'You can''t issue an OTP for this user.');
  end if;

  select a.email into v_email
    from public.authorized_users a
   where lower(a.email) = lower(trim(p_email)) and a.is_active;
  if v_email is null then
    return jsonb_build_object('ok', false, 'error', 'This user is not active.');
  end if;

  v_rand := ('x' || encode(extensions.gen_random_bytes(8), 'hex'))::bit(64)::bigint;
  v_otp  := (100000 + ((v_rand % 900000) + 900000) % 900000)::text;

  insert into public.access_sessions (email, otp_code, device_id, expires_at)
  values (v_email, v_otp, null, v_expires);

  return jsonb_build_object('ok', true, 'email', v_email, 'otp', v_otp, 'expires_at', v_expires);
end;
$$;

-- Same signatures as before, now scoped to what the caller may manage.
create or replace function public.reset_user_session(p_email text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if not public.dash_can_manage(p_email) then
    raise exception 'You can''t sign out this user.' using errcode = '42501';
  end if;
  delete from public.access_sessions where lower(email) = lower(trim(p_email));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.reset_all_sessions()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_org   text;
  v_count int;
begin
  select d.org into v_org
    from public.dashboard_users d
   where d.user_id = auth.uid() and d.can_manage_org;
  if v_org is null then
    raise exception 'Only team supervisors can reset all sessions.' using errcode = '42501';
  end if;
  delete from public.access_sessions s
   using public.authorized_users a
   where lower(a.email) = lower(s.email) and a.org = v_org;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function
  public.dash_can_view(text), public.dash_can_manage(text),
  public.dashboard_me(), public.dashboard_roster(), public.generate_otp(text),
  public.reset_user_session(text), public.reset_all_sessions()
  from public, anon;
grant execute on function
  public.dash_can_view(text), public.dash_can_manage(text),
  public.dashboard_me(), public.dashboard_roster(), public.generate_otp(text),
  public.reset_user_session(text), public.reset_all_sessions()
  to authenticated;

-- 6. Data: teams --------------------------------------------------------------
-- Everyone already in authorized_users is Astra (column default above).

-- Existing dashboard logins are Astra supervisors.
insert into public.dashboard_users (user_id, org, can_manage_org)
select id, 'astra', true
  from auth.users
 where lower(email) in (
   'abhishek.das@astraglobal.com', 'akworks247@gmail.com', 'ankit.gupta@astraglobal.com',
   'arsh.khera@astraglobal.com', 'ashish.mehta@astraglobal.com', 'gopesh.bhardwaj@astraglobal.com',
   'himanshu.narang@astraglobal.com', 'meera.sharma@astraglobal.com', 'rishabh.vats@astraglobal.com')
on conflict (user_id) do nothing;

-- Clear Nexus roster (Clear Nexus Roster.xlsx) + Credit Deployment.
insert into public.authorized_users (email, display_name, org, role) values
  ('allan.santiago@clearcustomerservice.com',     'Allan Santiago',     'clear_nexus', 'supervisor'),
  ('jeanice.alo@clearcustomerservice.com',        'Jeaniece Alo',       'clear_nexus', 'supervisor'),
  ('helena.aguillon@clearcustomerservice.com',    'Helena Aguillon',    'clear_nexus', 'agent'),
  ('nicole.arcilla@clearcustomerservice.com',     'Nicole Arcilla',     'clear_nexus', 'agent'),
  ('sandravivero@clearcustomerservice.com',       'Sandra Vivero',      'clear_nexus', 'agent'),
  ('johncarlo.david@clearcustomerservice.com',    'Jio David',          'clear_nexus', 'agent'),
  ('reshelle.acosta@clearcustomerservice.com',    'Reshelle Acosta',    'clear_nexus', 'agent'),
  ('april.aguiluz@clearcustomerservice.com',      'April Aguiluz',      'clear_nexus', 'agent'),
  ('vernie.gundao@clearcustomerservice.com',      'Vernie Gundao',      'clear_nexus', 'agent'),
  ('allizon.angustia@clearcustomerservice.com',   'Allizon Angustia',   'clear_nexus', 'agent'),
  ('kevin.quinto@clearcustomerservice.com',       'Kevin Quinto',       'clear_nexus', 'agent'),
  ('cyra.bilbao@clearcustomerservice.com',        'Cyra Bilbao',        'clear_nexus', 'agent'),
  ('jefferson.penalosa@clearcustomerservice.com', 'Jefferson Penalosa', 'clear_nexus', 'agent'),
  ('daniel.rodriguez@clearcustomerservice.com',   'Daniel Rodriguez',   'clear_nexus', 'agent'),
  ('trisha.penaranda@clearcustomerservice.com',   'Trisha Peñaranda',   'clear_nexus', 'agent'),
  ('andre.lazarra@clearcustomerservice.com',      'Andre Lazarra',      'clear_nexus', 'agent'),
  ('jhamaeca.pura@clearcustomerservice.com',      'Jhamaeca Pura',      'clear_nexus', 'agent'),
  ('erin.kieley@creditdeployment.com',            'Erin Kieley',        'credit_deployment', 'supervisor'),
  ('nicole.vorron@creditdeployment.com',          'Nicole Vorron',      'credit_deployment', 'supervisor')
on conflict (email) do update
  set display_name = excluded.display_name,
      org          = excluded.org,
      role         = excluded.role,
      is_active    = true;

-- The four new dashboard logins (Allan, Jeaniece, Erin, Nicole) are created in
-- Supabase Auth separately — passwords never go in a migration file. Their
-- dashboard_users rows:
--   Clear Nexus supervisors : org 'clear_nexus',       can_manage_org = true
--   Credit Deployment       : org 'credit_deployment', can_view_all   = true
