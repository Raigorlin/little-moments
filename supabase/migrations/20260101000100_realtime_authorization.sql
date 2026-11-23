-- realtime.messages 已啟用 RLS，而且 postgres 不是它的擁有者：不要寫 ALTER TABLE … ENABLE ROW LEVEL SECURITY，
-- Supabase 文件說明這個語句會以 42501 中止整個遷移。只建立政策。

grant usage on schema app to authenticated;   -- 只為了呼叫下面的函式；沒有任何資料表權限

-- 頻道 trip:<uuid> 只開放給這趟旅行綁定旅伴的帳號與管理員；旅行刪除後一律拒絕。
-- CASE 保證格式不對的 topic 不會被轉型成 uuid（轉型失敗會讓加入以錯誤結束）。
create function app.can_use_trip_topic(topic text)
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
          exists (select 1 from app.people p where p.trip_id = t.id and p.user_id = (select auth.uid()))
          or exists (select 1 from app.profiles a where a.user_id = (select auth.uid()) and a.role = 'admin')
        )
    )
  end;
$$;
revoke all on function app.can_use_trip_topic(text) from public;
grant execute on function app.can_use_trip_topic(text) to authenticated;

create policy "trip members receive broadcasts and presence"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and app.can_use_trip_topic((select realtime.topic()))
  );

-- 只允許 presence。沒有 broadcast 的 INSERT 政策，所以客戶端不能自己送 broadcast
-- （Realtime 對私有頻道的 RLS 拒絕一律靜默丟棄）；變更集只能由資料庫發出。
create policy "trip members track presence"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and app.can_use_trip_topic((select realtime.topic()))
  );
