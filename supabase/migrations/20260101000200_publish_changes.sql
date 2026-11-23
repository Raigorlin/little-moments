-- 每次提交寫入 app.trip_changes；trigger 在同一個交易中把變更集送到這趟旅行的私有頻道。
-- 交易回滾時 realtime.messages 的寫入一起回滾，所以不會推送沒有提交的變更。
-- 沒有任何連線者時提交照常成功，也不記錄警告；realtime.send() 會吞掉自己的錯誤，只在寫入 realtime.messages 失敗（例如沒有當天的 partition）時記錄 WarnSendingBroadcastMessage 警告，提交仍然成功，這次推送遺失，之後由補齊取得。
create function app.publish_trip_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    case
      when octet_length(new.payload::text) <= 65536 then new.payload
      else jsonb_build_object('trip', new.trip_id, 'seq', new.seq, 'thin', true)   -- 太大：只通知序號
    end,
    'changeset',
    'trip:' || new.trip_id::text,
    true                                                                            -- 私有頻道
  );
  return null;
end;
$$;
revoke all on function app.publish_trip_change() from public;

create trigger trip_changes_publish
  after insert on app.trip_changes
  for each row execute function app.publish_trip_change();
