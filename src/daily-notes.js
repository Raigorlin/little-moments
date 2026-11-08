export const DAILY_NOTES = Object.freeze([
  "行程不用排得滿滿，留一點空白給驚喜。",
  "把今天的小事，收成明天想起的微笑。",
  "一起吃飯的時候，平凡也有了滋味。",
  "有些風景，和喜歡的人看才完整。",
  "今天的陽光，值得多停留一會兒。",
  "把腳步放慢，讓快樂有機會跟上。",
  "不必等到遠方，巷口也藏著小旅行。",
  "笑聲不用打包，回憶會替我們收好。",
  "給日常一點留白，喜歡的事就住進來了。",
  "出發的理由，可以只是今天想見你。",
  "一杯熱茶，也能把午後變成好時光。",
  "今天遇到的小美好，記得留一份給自己。",
  "最喜歡的行程，是和你們待在一起。",
  "晚餐多煮一點，故事就能再聊一會兒。",
  "把喜歡的日子，過成想重播的片段。",
  "即使沒有特別安排，也可以特別開心。",
  "我們走過的路，會慢慢長成共同的故事。",
  "讓一頓早餐，成為今天溫柔的開場。",
  "有空看看天空，它每天都換了新模樣。",
  "快樂有時很小，小到剛好放進口袋。",
  "今天不趕路，陪風景坐一下。",
  "把手機放低一點，把眼前的人看清一點。",
  "記住今天的笑臉，比拍到完美照片重要。",
  "喜歡的事不必盛大，有一點點就很好。",
  "沿路聊的那些小事，後來都成了回憶。",
  "一個轉彎，說不定就遇見新的喜歡。",
  "帶上好奇心，熟悉的地方也能重新發現。",
  "把今天過得有味道，明天就有故事可說。",
  "一起洗菜切菜，也是旅行的一部分。",
  "好吃的東西，分享以後會多一份快樂。",
  "留一張照片，也留一點當時的心情。",
  "生活的亮點，有時是朋友隨口的一句話。",
  "今天的風很適合，吹散一點匆忙。",
  "不一定要做很多，能好好感受就很好。",
  "山有山的風景，家有家的溫暖。",
  "想起來會笑的瞬間，值得慢慢收藏。",
  "把椅子拉近一點，讓聊天再久一點。",
  "我們的小日常，也值得一本漂亮的手帳。",
  "旅途最好的紀念品，是一起度過的時間。",
  "讓喜歡的人，出現在喜歡的日子裡。",
  "回家的路上，再說一件今天最開心的事。",
  "普通的一天，也能有值得記住的一口甜。",
  "把日子過得柔軟一點，把笑容留得久一點。",
  "今天收集一種聲音，例如朋友的笑聲。",
  "不用追著快樂跑，先看看它是不是就在身旁。",
  "一頓慢慢吃的飯，是給生活的小小禮物。",
  "有你們在，迷路也可能變成好故事。",
  "想去的地方先記下來，下一次一起出發。",
  "有些美好，適合不趕時間地發生。",
  "把晚風留給散步，把今晚留給聊天。",
  "用喜歡的杯子，喝一口今天的好心情。",
  "每次相聚，都替我們的故事添一頁。",
  "計畫可以留白，回憶會慢慢填滿。",
  "今天的小確幸，也許正在下一個路口。",
  "日落不用催，值得的時刻可以慢慢等。",
  "一起看過的星星，回想起來還是很亮。",
  "把今天的感謝說出來，讓溫暖多走一點路。",
  "生活不是每天都閃亮，但總有片刻值得喜歡。",
  "帶著今天的小美好，期待下一次見面。",
  "願回頭看的時候，我們記得的都是笑著的自己。"
]);

const DAY_MS = 86_400_000;
const TAIPEI_OFFSET = 8 * 60 * 60 * 1000;

export function dailyNote(date = new Date()) {
  const timestamp = Number(date);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid date");
  const day = Math.floor((timestamp + TAIPEI_OFFSET) / DAY_MS);
  const index = ((day % DAILY_NOTES.length) + DAILY_NOTES.length) % DAILY_NOTES.length;
  return {date: new Date(day * DAY_MS).toISOString().slice(0, 10), index, text: DAILY_NOTES[index]};
}

export function nextTaipeiMidnight(date = new Date()) {
  const timestamp = Number(date);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid date");
  return (Math.floor((timestamp + TAIPEI_OFFSET) / DAY_MS) + 1) * DAY_MS - TAIPEI_OFFSET;
}


export function setupDailyNote({document: doc = globalThis.document, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  if (!doc) return () => {};
  let timer;
  const refresh = () => {
    const current = now(), note = dailyNote(current);
    for (const el of doc.querySelectorAll('[data-daily-quote]')) el.textContent = note.text;
    for (const el of doc.querySelectorAll('[data-daily-date]')) {
      el.setAttribute('datetime', note.date);
      el.textContent = note.date.slice(5).replace('-', '/');
    }
    clearTimer(timer);
    timer = setTimer(refresh, nextTaipeiMidnight(current) - Number(current) + 50);
  };
  const onVisible = () => { if (doc.visibilityState === 'visible') refresh(); };
  doc.addEventListener('visibilitychange', onVisible);
  doc.defaultView?.addEventListener('pageshow', refresh);
  refresh();
  return () => {
    clearTimer(timer);
    doc.removeEventListener('visibilitychange', onVisible);
    doc.defaultView?.removeEventListener('pageshow', refresh);
  };
}
