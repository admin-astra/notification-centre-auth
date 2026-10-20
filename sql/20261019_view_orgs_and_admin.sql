-- =============================================================================
-- Per-login visible teams + Admin
-- =============================================================================
-- Applied to the "CDS Extension" Supabase project (mfixofximhpmixdkyggb),
-- after 20261019_org_scoped_access.sql.
--
-- dashboard_users.view_orgs     extra teams a login can SEE (read-only), on top
--                               of its own team. can_view_all still means every team.
-- dashboard_users.display_name  name shown in the dashboard header (e.g. "Admin").
--
-- Credit Deployment (Erin, Nicole): Credit Deployment + Clear Nexus, not Astra.
-- Admin (arsh.khera@astraglobal.com): every team; still manages Astra.
-- The Admin password is set in Supabase Auth separately, never in a file.
-- =============================================================================

alter table public.dashboard_users
  add column if not exists view_orgs    text[] not null default '{}',
  add column if not exists display_name text;

alter table public.dashboard_users
  add constraint dashboard_users_view_orgs_check
  check (view_orgs <@ array['astra', 'clear_nexus', 'credit_deployment']::text[]);

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
            or a.org = d.org
            or a.org = any (d.view_orgs))
  );
$$;

create or replace function public.dashboard_me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
           'email',          u.email,
           'org',            d.org,
           'can_view_all',   d.can_view_all,
           'can_manage_org', d.can_manage_org,
           'view_orgs',      to_jsonb(d.view_orgs),
           'display_name',   coalesce(d.display_name, a.display_name))
    from public.dashboard_users d
    join auth.users u on u.id = d.user_id
    left join public.authorized_users a on lower(a.email) = lower(u.email)
   where d.user_id = auth.uid();
$$;

-- Credit Deployment: own team + Clear Nexus only.
update public.dashboard_users d
   set can_view_all = false,
       view_orgs    = array['clear_nexus']
  from auth.users u
 where u.id = d.user_id
   and lower(u.email) in ('erin.kieley@creditdeployment.com', 'nicole.vorron@creditdeployment.com');

-- Admin: every team, keeps managing Astra.
update public.dashboard_users d
   set can_view_all   = true,
       can_manage_org = true,
       display_name   = 'Admin'
  from auth.users u
 where u.id = d.user_id
   and lower(u.email) = 'arsh.khera@astraglobal.com';
