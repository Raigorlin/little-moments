import {test,expect} from './local-planner-fixture.js';
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));
// Browser OCR is removed (security-hardening Req 22.5): no OCR assets are built or served, and the CSP allows no WASM evaluation (Req 9.11).
test('[TC-OCR-001] browser OCR assets are gone, CSP has no wasm-unsafe-eval, photos have no public upload route',async({page:p,request})=>{
 const urls=[];p.on('request',r=>urls.push(r.url()));
 const response=await p.goto('/demo/#/trip');await expect(p.locator('.hero')).toBeVisible();
 const csp=response.headers()['content-security-policy'];
 expect(csp).toContain("script-src 'self'");expect(csp).not.toContain("'wasm-unsafe-eval'");expect(csp).not.toContain("'unsafe-eval'");expect(csp).toContain("connect-src 'self'");
 await p.evaluate(async()=>{await navigator.serviceWorker.ready;});expect(urls.filter(u=>u.includes('/assets/ocr/'))).toEqual([]);
 const sw=await (await request.get('/sw.js')).text();expect(sw).not.toContain('/assets/ocr/');
 const worker=await request.get('/assets/ocr/worker.min.js');expect(worker.status()).toBe(404);
 expect(worker.headers()['content-security-policy']).not.toContain("'wasm-unsafe-eval'");
 for(const path of ['/assets/ocr/core/tesseract-core-lstm.wasm.js','/assets/ocr/lang/chi_tra.traineddata.gz','/uploads/receipt.png','/data/receipts/image.jpg','/node_modules/tesseract.js/package.json'])expect((await request.get(path)).status()).toBe(404);
});
