export async function syntheticReceipt(page, {chinese=false}={}) {
 const png=await page.evaluate(async({chinese})=>{
  await document.fonts.ready;
  const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=850;
  const c=canvas.getContext('2d');c.fillStyle='#ffffff';c.fillRect(0,0,1000,850);c.fillStyle='#000000';c.textBaseline='top';
  c.font=chinese?'44px "Microsoft JhengHei", sans-serif':'44px Arial';
  const rows=chinese?[['測試超市',''],['高麗菜','80'],['雞蛋','65'],['牛肉片','210'],['總計','355']]:[['TEST MARKET',''],['CABBAGE','80'],['EGGS','65'],['BEEF','210'],['TOTAL','355']];
  rows.forEach(([title,price],i)=>{c.textAlign='left';c.fillText(title,60,80+i*125);c.textAlign='right';c.fillText(price,920,80+i*125);});
  return canvas.toDataURL('image/png').split(',')[1];
 },{chinese});
 return {name:chinese?'synthetic-receipt-zh.png':'synthetic-receipt.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')};
}
