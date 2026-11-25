-- 管理後台（需求 37、40、41，design 5.5）：停用帳號、公開註冊的設定與操作紀錄。
-- 不修改 realtime.messages 的 RLS 設定（見 20260101000100_realtime_authorization.sql 開頭的說明）。

-- 需求 40.1：不是空值的帳號是 Disabled_Account。
alter table app.profiles add column disabled_at timestamptz;

-- 需求 37.1：目前只有 public_signup，值只能是 open 或 closed。
create table app.settings (
  key        text primary key check (key in ('public_signup')),
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app.profiles(user_id) on delete set null,
  constraint settings_public_signup_value check (key <> 'public_signup' or value in ('open', 'closed'))
);

-- 需求 41.1、41.2：操作代碼只能是需求 41.2 列出的值；執行者被刪除時保留紀錄。
create table app.audit (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  actor_id uuid references app.profiles(user_id) on delete set null,
  action   text not null check (action in ('account.register', 'admin.user.update', 'admin.user.password_reset',
             'admin.user.disable', 'admin.user.enable', 'admin.settings.public_signup', 'trip.create', 'trip.delete',
             'invite.create', 'invite.revoke', 'invite.join')),
  target   text not null check (char_length(target) <= 120),
  detail   text not null default '' check (char_length(detail) <= 200)
);
create index audit_at_desc on app.audit (at desc, id desc);

-- 都不建立政策（需求 6.14）：只有 lm-server 以 postgres 角色讀寫。
alter table app.settings enable row level security;
alter table app.audit enable row level security;
revoke all on app.settings, app.audit from anon, authenticated;

-- 需求 40.4：Disabled_Account 不能加入或重新加入 Trip_Channel。與原本的定義只差兩個條件各加上
-- disabled_at is null（design 5.2）。
create or replace function app.can_use_trip_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when topic !~ '^trip:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else exists (
      select 1
      from app.trips t
      where t.id = substring(topic from 6)::uuid
        and t.deleted_at is null
        and (
          exists (
            select 1
            from app.people p
            join app.profiles pp on pp.user_id = p.user_id
            where p.trip_id = t.id and p.user_id = (select auth.uid()) and pp.disabled_at is null
          )
          or exists (
            select 1 from app.profiles a
            where a.user_id = (select auth.uid()) and a.role = 'admin' and a.disabled_at is null
          )
        )
    )
  end;
$$;
revoke all on function app.can_use_trip_topic(text) from public;
grant execute on function app.can_use_trip_topic(text) to authenticated;
