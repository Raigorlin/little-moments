-- 應用資料表放在 app schema：不在 PostgREST 的 api.schemas 中，anon 與 authenticated 沒有任何資料表權限。
-- lm-server 以資料表擁有者連線；所有資料表都啟用 RLS 且不建立政策，作為防線。
create schema app;
revoke all on schema app from public;

create table app.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z][a-z0-9-]{2,31}$'),
  display_name text not null check (char_length(display_name) between 1 and 30),
  role         text not null default 'member' check (role in ('admin', 'member')),
  created_at   timestamptz not null default now()
);

create table app.trips (
  id           uuid primary key,
  owner_id     uuid not null references app.profiles(user_id),
  title        text not null check (char_length(title) between 1 and 100),
  destination  text not null default '' check (char_length(destination) <= 100),
  start_date   date not null,
  end_date     date not null,
  description  text not null default '' check (char_length(description) <= 1000),
  note         text not null default '' check (char_length(note) <= 1000),
  cover_kind   text not null default 'camp'
               check (cover_kind in ('camp', 'mountain', 'lake', 'night', 'forest', 'beach', 'sunrise')),
  status       text not null default 'planning' check (status in ('planning', 'completed')),
  seq          bigint not null default 0,      -- 最後一次提交的序號
  next_ordinal bigint not null default 0,      -- 下一個新列的建立順序
  version      bigint not null default 0,      -- 旅行卡片本身最後被修改的 seq
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,                     -- 刪除旅行只設定這個欄位，可以復原
  check (end_date >= start_date and end_date - start_date <= 30)
);

-- 旅伴。user_id 不為空表示綁定了帳號；旅行成員資格 = 這趟旅行有一位旅伴綁定了該帳號。
create table app.people (
  trip_id  uuid not null references app.trips(id) on delete cascade,
  id       uuid not null,
  user_id  uuid references app.profiles(user_id),
  name     text not null check (char_length(name) between 1 and 30),
  name_key text not null,                       -- participant_key(name)
  role     text not null default '' check (char_length(role) <= 60),
  color    text not null check (color in ('coral', 'blue', 'green', 'yellow', 'lavender', 'peach')),
  ordinal  bigint not null,
  version  bigint not null,
  primary key (trip_id, id),
  unique (trip_id, user_id),
  unique (trip_id, name_key) deferrable initially deferred
);
create index people_user on app.people (user_id) where user_id is not null;

create table app.places (
  trip_id  uuid not null references app.trips(id) on delete cascade,
  id       uuid not null,
  name     text not null check (char_length(name) between 1 and 50),
  name_key text not null,                       -- place_key(name)；與旅行目的地的比對由 lm-core 檢查
  ordinal  bigint not null,
  version  bigint not null,
  primary key (trip_id, id),
  unique (trip_id, name_key) deferrable initially deferred
);

create table app.vehicles (
  trip_id   uuid not null references app.trips(id) on delete cascade,
  id        uuid not null,
  name      text not null check (char_length(name) between 1 and 50),
  driver_id uuid,
  seats     smallint not null check (seats between 1 and 9),
  color     text check (color ~ '^#[0-9a-f]{6}$'),
  ordinal   bigint not null,
  version   bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, driver_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.vehicle_passengers (
  trip_id    uuid not null,
  vehicle_id uuid not null,
  person_id  uuid not null,
  primary key (trip_id, vehicle_id, person_id),
  foreign key (trip_id, vehicle_id) references app.vehicles (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

-- 路線端點與停靠點的 place_id 為 NULL 時代表旅行目的地。
create table app.routes (
  trip_id       uuid not null references app.trips(id) on delete cascade,
  id            uuid not null,
  day           date not null,
  vehicle_id    uuid not null,
  from_place_id uuid,
  to_place_id   uuid,
  depart_time   text check (depart_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ordinal       bigint not null,
  version       bigint not null,
  primary key (trip_id, id),
  unique (trip_id, day, vehicle_id) deferrable initially deferred,
  foreign key (trip_id, vehicle_id) references app.vehicles (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, from_place_id) references app.places (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, to_place_id) references app.places (trip_id, id) deferrable initially deferred
);

create table app.stops (
  trip_id   uuid not null,
  id        uuid not null,
  route_id  uuid not null,
  position  smallint not null check (position between 0 and 5),
  place_id  uuid,
  kind      text not null check (kind in ('shop', 'pickup', 'gear', 'other')),
  task_kind text check (task_kind in ('shopping', 'gear-pickup', 'gear-return', 'passenger-pickup',
                                      'passenger-dropoff', 'car-rental', 'car-return', 'waypoint')),
  note      text not null default '' check (char_length(note) <= 100),
  stop_time text check (stop_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  primary key (trip_id, id),
  unique (trip_id, route_id, position) deferrable initially deferred,
  foreign key (trip_id, route_id) references app.routes (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, place_id) references app.places (trip_id, id) deferrable initially deferred
);

create table app.day_settings (
  trip_id        uuid not null references app.trips(id) on delete cascade,
  day            date not null,
  title          text check (char_length(title) <= 20),
  place_id       uuid,
  arrival        text check (arrival ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  route_position text not null default 'before' check (route_position in ('before', 'after')),
  version        bigint not null,
  primary key (trip_id, day),
  foreign key (trip_id, place_id) references app.places (trip_id, id) deferrable initially deferred
);

create table app.activities (
  trip_id    uuid not null references app.trips(id) on delete cascade,
  id         uuid not null,
  day        date not null,
  start_time text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  title      text not null check (char_length(title) between 1 and 100),
  kind       text not null check (kind in ('meet', 'market', 'camp', 'meal', 'night', 'travel', 'wake',
                                           'pitch', 'free', 'tea', 'strike', 'clean', 'return')),
  location   text not null default '' check (char_length(location) <= 150),
  note       text not null default '' check (char_length(note) <= 1000),
  done       boolean not null default false,
  ordinal    bigint not null,
  version    bigint not null,
  primary key (trip_id, id)
);

-- 兩張子表最多只有一張有資料：都沒有 = 全體旅伴；activity_vehicles 有資料 = 指定車輛。
create table app.activity_people (
  trip_id     uuid not null,
  activity_id uuid not null,
  person_id   uuid not null,
  primary key (trip_id, activity_id, person_id),
  foreign key (trip_id, activity_id) references app.activities (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.activity_vehicles (
  trip_id     uuid not null,
  activity_id uuid not null,
  vehicle_id  uuid not null,
  primary key (trip_id, activity_id, vehicle_id),
  foreign key (trip_id, activity_id) references app.activities (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, vehicle_id) references app.vehicles (trip_id, id) deferrable initially deferred
);

create table app.meals (
  trip_id     uuid not null references app.trips(id) on delete cascade,
  id          uuid not null,
  day         date not null,
  slot        text not null check (slot in ('早餐', '午餐', '下午茶', '晚餐', '消夜')),
  meal_time   text check (meal_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  title       text not null default '' check (char_length(title) <= 100),
  cook_id     uuid,
  servings    smallint not null check (servings between 1 and 100),
  ingredients text not null default '' check (char_length(ingredients) <= 2000),
  notes       text not null default '' check (char_length(notes) <= 1000),
  dish_kind   text check (dish_kind in ('hotpot', 'bbq', 'toast', 'curry', 'pasta', 'breakfast', 'salad', 'custom')),
  ordinal     bigint not null,
  version     bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, cook_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.shopping_items (
  trip_id        uuid not null references app.trips(id) on delete cascade,
  id             uuid not null,
  name           text not null check (char_length(name) between 1 and 100),
  quantity       text not null default '' check (char_length(quantity) <= 40),
  category       text not null check (category in ('肉類', '海鮮', '蔬菜', '水果', '蛋奶', '豆製品',
                                                   '主食', '調味料', '飲料', '零食', '其他')),
  assignee_id    uuid,
  purchased      boolean not null default false,
  source         text not null check (source in ('meal', 'manual')),
  recipe_removed boolean,
  ordinal        bigint not null,
  version        bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, assignee_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.shopping_item_meals (
  trip_id uuid not null,
  item_id uuid not null,
  meal_id uuid not null,
  primary key (trip_id, item_id, meal_id),
  foreign key (trip_id, item_id) references app.shopping_items (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, meal_id) references app.meals (trip_id, id) deferrable initially deferred
);

create table app.gear_items (
  trip_id     uuid not null references app.trips(id) on delete cascade,
  id          uuid not null,
  name        text not null check (char_length(name) between 1 and 100),
  quantity    text not null default '' check (char_length(quantity) <= 40),
  scope       text not null check (scope in ('personal', 'shared')),
  assignee_id uuid,
  ordinal     bigint not null,
  version     bigint not null,
  primary key (trip_id, id),
  check (scope = 'shared' or assignee_id is null),
  foreign key (trip_id, assignee_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.gear_packed (
  trip_id   uuid not null,
  gear_id   uuid not null,
  person_id uuid not null,
  primary key (trip_id, gear_id, person_id),
  foreign key (trip_id, gear_id) references app.gear_items (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.departures (
  trip_id     uuid not null,
  person_id   uuid not null,
  departed_at timestamptz not null default now(),
  version     bigint not null,
  primary key (trip_id, person_id),
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.expenses (
  trip_id          uuid not null references app.trips(id) on delete cascade,
  id               uuid not null,
  spent_on         date not null,
  title            text not null check (char_length(title) between 1 and 100),
  amount_cents     bigint not null check (amount_cents between 1 and 100000000),
  payer_id         uuid not null,
  category         text not null,               -- EXPENSE_CATEGORIES（含「食材／{分類}」）由 lm-core 檢查
  note             text not null default '' check (char_length(note) <= 500),
  shopping_item_id uuid,
  ordinal          bigint not null,
  version          bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, payer_id) references app.people (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, shopping_item_id) references app.shopping_items (trip_id, id) deferrable initially deferred
);

create table app.expense_participants (
  trip_id    uuid not null,
  expense_id uuid not null,
  person_id  uuid not null,
  primary key (trip_id, expense_id, person_id),
  foreign key (trip_id, expense_id) references app.expenses (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.settlements (
  trip_id      uuid not null references app.trips(id) on delete cascade,
  id           uuid not null,
  paid_on      date not null,
  from_id      uuid not null,
  to_id        uuid not null,
  amount_cents bigint not null check (amount_cents between 1 and 100000000),
  note         text not null default '' check (char_length(note) <= 500),
  ordinal      bigint not null,
  version      bigint not null,
  primary key (trip_id, id),
  check (from_id <> to_id),
  foreign key (trip_id, from_id) references app.people (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, to_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.invites (
  id         uuid primary key,
  trip_id    uuid not null references app.trips(id) on delete cascade,
  token_hash text not null unique,              -- SHA-256(token) 的十六進位；token 本身不保存
  created_by uuid not null references app.profiles(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,              -- created_at + 7 天
  revoked_at timestamptz,
  used_at    timestamptz,
  used_by    uuid references app.profiles(user_id)
);
create index invites_trip on app.invites (trip_id);

-- 每次提交一列：補齊、冪等與推送的來源。第一版不清除舊資料。
create table app.trip_changes (
  trip_id      uuid not null references app.trips(id) on delete cascade,
  seq          bigint not null,
  command_id   uuid not null,
  actor_id     uuid not null references app.profiles(user_id),
  payload      jsonb not null,                  -- ChangeSet 的 JSON
  committed_at timestamptz not null default now(),
  primary key (trip_id, seq),
  unique (trip_id, command_id)
);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;
revoke all on all tables in schema app from anon, authenticated;
