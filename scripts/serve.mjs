import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccountService,PublicDbPathError} from '../server/accounts.js';
import {createHttpHandler} from '../server/http.js';
import {createReceiptAi} from '../server/receipt-ai.js';
import {ConfigError,parseDeploymentConfig,resolveDbPath,formatStartupLines} from '../server/deploy-config.js';
import {parseAiCostConfig} from '../server/ai-cost.js';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let config,aiCost;
// Both parsers throw ConfigError, so an invalid deployment or AI_Cost_Config value stops startup the same way (Req 18.2).
try{config=parseDeploymentConfig(process.env);aiCost=parseAiCostConfig(process.env);}
catch(error){if(!(error instanceof ConfigError))throw error;console.error(`Configuration error: ${error.message}`);process.exit(1);}
const dbPath=resolveDbPath(process.env,project);
const distRoot=resolve(project,process.env.CAMPING_DIST||'dist');
let accounts;
// The DB path guard (Req 20.9) refuses a publicly servable database before anything listens.
try{accounts=createAccountService({dbPath,publicRoots:[distRoot],receiptAi:createReceiptAi({env:process.env,cost:aiCost}),aiCost,deployment:config,allowLoopbackHostFromContainer:config.dockerLocalOnly});}
catch(error){if(!(error instanceof PublicDbPathError))throw error;console.error(error.message);process.exit(1);}
const server=Bun.serve({hostname:config.bindHost,port:config.port,maxRequestBodySize:4_194_304,fetch:createHttpHandler({root:distRoot,accounts,config})});
// Log lines come only from config fields and the effective receipt AI policy; never from secrets.
for(const line of formatStartupLines({...config,port:server.port},accounts.receiptAiPolicy?.()??'all'))console.log(line);
if(config.published&&accounts.needsSetup())console.log('No administrator exists yet. On this server, run: bun run create-admin (uses the same CAMPING_DB).');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.stop(true);accounts.close();process.exit(0);});
