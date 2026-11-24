-- 行程繪本工作室編輯、而第一版的資料表沒有的欄位。都有預設值，既有的列不需要搬移；Itinerary_Text 不輸出這些欄位。

-- 繪本的大標題（0–80 字）與底部短語（0–150 字）；空字串是未設定。
alter table app.trips
  add column headline text not null default '' check (char_length(headline) <= 80),
  add column caption  text not null default '' check (char_length(caption) <= 150);

-- 新增地點時選擇的繪本插圖；NULL 是沒有選擇。
alter table app.places
  add column template text
    check (template in ('home', 'market', 'seven-eleven', 'familymart', 'okmart', 'pxmart-mega', 'costco',
                        'ikea', 'carrefour', 'tent', 'bell', 'dome', 'tarp', 'camper', 'cabin'));

-- 採買以外的停靠點的待辦清單或旅伴名單：最多 8 項，每項 1–100 字（lm-core 檢查每一項）。
alter table app.stops
  add column items text[] not null default '{}' check (cardinality(items) <= 8);

-- 繪本日卡的抵達說明（1–120 字）；NULL 是未設定。
alter table app.day_settings
  add column arrival_label text check (char_length(arrival_label) <= 120);
