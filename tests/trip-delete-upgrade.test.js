// 原 SQLite 版本以子程序開啟檔案資料庫、DROP trip_deletions 後確認服務重新建立該表且不改寫既有資料列。
// PostgreSQL 版（任務 5.13）：Schema 由 Migration_Runner 建立，服務本身不再執行 DDL；
// 此處驗證遷移後的 trip_deletions 存在且為空、重新建立服務不改寫既有資料列，以及關閉服務不關閉注入的連線池。
import {test,expect} from 'bun:test';
import {createAccountService} from '../server/accounts.js';
import {useTestDatabase,resetTables,serviceDb} from './support/pg.js';

const db=useTestDatabase();
const BASE='http://127.0.0.1:5181';
const plain=rows=>Array.from(rows,row=>({...row}));
const readAll=async()=>({
 users:plain(await db.sql`SELECT * FROM users ORDER BY id`),
 trips:plain(await db.sql`SELECT * FROM trips ORDER BY id`),
 trip_members:plain(await db.sql`SELECT * FROM trip_members ORDER BY trip_id, user_id`),
 sessions:plain(await db.sql`SELECT * FROM sessions ORDER BY token_hash`),
 invites:plain(await db.sql`SELECT * FROM invites ORDER BY token_hash`),
 audit:plain(await db.sql`SELECT * FROM audit ORDER BY id`),
});

test('existing account data keeps deletion metadata empty and is not rewritten when the service restarts',async()=>{
 await resetTables(db.sql);
 let service=await createAccountService({db:serviceDb(db.sql)});
 try{
  const send=(url,data,cookie)=>service.handle(new Request(BASE+url,{method:'POST',headers:{Origin:BASE,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)}));
  const setup=await send('/api/setup',{username:'upgrade-admin',displayName:'Upgrade',password:'Only-For-Upgrade-Test'});expect(setup.status).toBe(200);
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  const trip=await send('/api/trips',{title:'既有露營回憶',destination:'湖邊',startDate:'2026-11-20',endDate:'2026-11-21',description:'',note:'',coverKind:'lake',status:'completed'},cookie);expect(trip.status).toBe(201);
  service.close();
  const before=await readAll();

  service=await createAccountService({db:serviceDb(db.sql)});service.close();
  const tables=await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'trip_deletions'`;
  expect(tables.length).toBe(1);
  expect(plain(await db.sql`SELECT * FROM trip_deletions`)).toEqual([]);
  expect(await readAll()).toEqual(before);
 }finally{service.close();}
});

test('closing the account service is idempotent and leaves the injected pool open',async()=>{
 const service=await createAccountService({db:serviceDb(db.sql)});
 expect(()=>service.close()).not.toThrow();
 expect(()=>service.close()).not.toThrow();
 expect(Number((await db.sql`SELECT 1 AS ok`)[0].ok)).toBe(1);
});
