-- Supabase Database 的部署後設定（plan.md D6）：lm-deploy 每次部署（與還原演練）在 db 通過健康檢查後執行，
-- 可重複執行。由 ~/lm-spike/stack.sh start_database 在 Supabase 遷移之後執行的 SQL 移植（Supabase CLI 的做法）。
--
--   docker compose ... exec -T db psql -h /run/postgresql -U supabase_admin -d postgres \
--     -v ON_ERROR_STOP=1 --no-psqlrc -q -f - < /srv/lm/<env>/supabase/db-setup.sql
--
-- 秘密不出現在本檔或指令列：psql 的 \getenv 讀取 db 容器的環境（compose.yaml 由 app.env 的 LM_DB_PASSWORD、
-- LM_JWT_SECRET 替換為 POSTGRES_PASSWORD、JWT_SECRET）。本次連線關閉陳述式記錄，ALTER USER 的密碼不寫入 Postgres 日誌。
--
-- 角色：映像的 init-scripts 建立 authenticator、pgbouncer、supabase_auth_admin、supabase_storage_admin、
-- supabase_replication_admin、supabase_read_only_user（無密碼），migrate.sh 建立 postgres 並設定 supabase_admin 的密碼。
-- 這裡另外設定 supabase_admin，讓輪替 LM_DB_PASSWORD 後 Realtime（以 supabase_admin 連線）仍可登入。

\set ON_ERROR_STOP on
SET log_statement = 'none';
SET log_min_duration_statement = -1;

\getenv pw POSTGRES_PASSWORD
\getenv jwt_secret JWT_SECRET
\getenv jwt_exp JWT_EXP

\if :{?pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'db 容器沒有 POSTGRES_PASSWORD'; END $$;
\endif
\if :{?jwt_secret}
\else
DO $$ BEGIN RAISE EXCEPTION 'db 容器沒有 JWT_SECRET'; END $$;
\endif
\if :{?jwt_exp}
\else
\set jwt_exp 3600
\endif

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';

ALTER USER supabase_admin WITH PASSWORD :'pw';
ALTER USER postgres WITH PASSWORD :'pw';
ALTER USER authenticator WITH PASSWORD :'pw';
ALTER USER pgbouncer WITH PASSWORD :'pw';
ALTER USER supabase_auth_admin WITH PASSWORD :'pw';
ALTER USER supabase_storage_admin WITH PASSWORD :'pw';
ALTER USER supabase_replication_admin WITH PASSWORD :'pw';
ALTER USER supabase_read_only_user WITH PASSWORD :'pw';

-- Realtime 的 DB_AFTER_CONNECT_QUERY 是 SET search_path TO _realtime，啟動前此 schema 必須存在。
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO postgres;
