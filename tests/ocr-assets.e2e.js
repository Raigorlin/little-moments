import {test,expect} from './local-planner-fixture.js';
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));
test('OCR assets are same-origin and on demand, CSP allows only WASM evaluation, photos have no public upload route',async({page:p,request})=>{
 const urls=[];p.on('request',r=>urls.push(r.url()));
 const response=await p.goto('/demo/#/trip');await expect(p.locator('.hero')).toBeVisible();
 const csp=response.headers()['content-security-policy'];expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");expect(csp).not.toContain("'unsafe-eval'");expect(csp).toContain("worker-src 'self'");expect(csp).toContain("connect-src 'self'");
 await p.evaluate(async()=>{await navigator.serviceWorker.ready;});expect(urls.filter(u=>u.includes('/assets/ocr/'))).toEqual([]);
 const sw=await (await request.get('/sw.js')).text();expect(sw).not.toContain('/assets/ocr/');
 for(const path of ['/assets/ocr/worker.min.js','/assets/ocr/core/tesseract-core-lstm.wasm.js','/assets/ocr/core/tesseract-core-simd-lstm.wasm.js','/assets/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js','/assets/ocr/lang/chi_tra.traineddata.gz','/assets/ocr/lang/eng.traineddata.gz']){
  const r=await request.head(path);expect(r.status()).toBe(200);expect(r.headers()['x-content-type-options']).toBe('nosniff');
 }
 for(const path of ['/uploads/receipt.png','/data/receipts/image.jpg','/node_modules/tesseract.js/package.json'])expect((await request.get(path)).status()).toBe(404);
});
