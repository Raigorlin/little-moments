import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createAccountService} from '../server/accounts.js';

// Process isolation ensures Windows releases SQLite mappings before cleanup.
// This test never opens data/accounts.sqlite.
test('existing account database gains deletion metadata without rewriting users or trip contents',()=>{
 const root=join(homedir(),'.aki','tmp');mkdirSync(root,{recursive:true});
 const dir=mkdtempSync(join(root,'camping-trip-upgrade-')),path=join(dir,'fixture.sqlite');
 try{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/trip-delete-upgrade.mjs',import.meta.url)),path],{encoding:'utf8',timeout:15000});
  expect(result.error).toBeUndefined();
  expect(result.status,`${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('UPGRADE_FIXTURE_OK: existing rows unchanged; integrity ok');
 }finally{rmSync(dir,{recursive:true,force:true});}
},20000);

test('closing file-backed account service releases SQLite handles without garbage collection',()=>{
 const root=join(homedir(),'.aki','tmp');mkdirSync(root,{recursive:true});
 const dir=mkdtempSync(join(root,'camping-trip-upgrade-'));
 const service=createAccountService({dbPath:join(dir,'fixture.sqlite')});
 try{
  expect(()=>service.close()).not.toThrow();
  expect(()=>service.close()).not.toThrow();
  rmSync(dir,{recursive:true,force:true});
  expect(existsSync(dir)).toBe(false);
 }finally{service.close();if(existsSync(dir))rmSync(dir,{recursive:true,force:true});}
});
