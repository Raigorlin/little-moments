import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {createAccountService} from '../../server/accounts.js';

// Only the parent test's generated fixture path is accepted, never the real database.
const path=process.argv[2];
assert.match(path,/[\\/]camping-trip-upgrade-[^\\/]+[\\/]fixture\.sqlite$/);
let service,db;
const readAll=database=>Object.fromEntries(['users','trips','trip_members','sessions','invites','audit','sqlite_sequence'].map(table=>[table,database.query(`SELECT * FROM ${table}`).all()]));
try{
 service=createAccountService({dbPath:path});
 const send=(url,data,cookie)=>service.handle(new Request('http://127.0.0.1:5181'+url,{method:'POST',headers:{Origin:'http://127.0.0.1:5181','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)}));
 const setup=await send('/api/setup',{username:'upgrade-admin',displayName:'Upgrade',password:'Only-For-Upgrade-Test'});assert.equal(setup.status,200);
 const cookie=setup.headers.get('set-cookie').split(';')[0];
 const trip=await send('/api/trips',{title:'既有露營回憶',destination:'湖邊',startDate:'2026-11-20',endDate:'2026-11-21',description:'',note:'',coverKind:'lake',status:'completed'},cookie);assert.equal(trip.status,201);
 service.close();service=null;
 db=new Database(path);db.exec('DROP TABLE IF EXISTS trip_deletions');
 const before=readAll(db);db.close();db=null;
 service=createAccountService({dbPath:path});service.close();service=null;
 db=new Database(path,{readonly:true});
 assert.ok(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='trip_deletions'").get());
 assert.deepEqual(db.query('SELECT * FROM trip_deletions').all(),[]);
 assert.deepEqual(readAll(db),before);
 assert.equal(db.query('PRAGMA integrity_check').get().integrity_check,'ok');
 console.log('UPGRADE_FIXTURE_OK: existing rows unchanged; integrity ok');
}finally{service?.close();db?.close();}
