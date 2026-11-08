function k(c,K){if(c.vehicleIds===void 0)return!0;let R=c.vehicleIds;return Array.isArray(R)&&R.length>0&&R.length<=K.length&&new Set(R).size===R.length&&R.every((Y)=>typeof Y==="string"&&K.some((X)=>X.id===Y))&&Array.isArray(c.people)&&c.people.length===0}var ke=(c)=>[c.driver,...c.passengers].filter(Boolean);function H(c,K,R){let Y=c.vehicles.find((X)=>X.id===R);if(!Y)return!1;if(K.vehicleIds!==void 0)return K.vehicleIds.includes(R);return K.people.length===0||ke(Y).some((X)=>K.people.includes(X))}function U(c,K,R){if(K.vehicleIds!==void 0)return c.vehicles.some((Y)=>K.vehicleIds.includes(Y.id)&&ke(Y).includes(R));return K.people.length===0||K.people.includes(R)}function D(c,K){if(K.vehicleIds!==void 0)return K.vehicleIds.map((R)=>c.vehicles.find((Y)=>Y.id===R)?.name||"車輛待確認").join("、");if(!K.people.length||c.people.every((R)=>K.people.includes(R.id)))return"全體旅伴";return K.people.map((R)=>c.people.find((Y)=>Y.id===R)?.name||"旅伴待確認").join("、")}var f=["肉類","海鮮","蔬菜","水果","蛋奶","豆製品","主食","調味料","飲料","零食","其他"],pe=(c)=>c.normalize("NFKC").replace(/\s+/gu,"").toLocaleLowerCase("zh-TW");function n(c=""){let K=new Map;for(let R of c.normalize("NFKC").split(/[、，;；\/。\r\n]+|(?<!\d)[,.]|[,.](?!\d)/u)){let Y=R.normalize("NFKC").trim().replace(/\s+/gu," ");if(Y&&!K.has(pe(Y)))K.set(pe(Y),Y)}return[...K.values()]}var He=[["零食",/玉米片|蛋糕/],["蛋奶",/茶葉蛋/],["肉類",/(?:蒜味|蒜香)香腸|薑母鴨|鹽酥雞|麻油雞|醬燒雞腿/],["調味料",/醬油|鹽麴|^鹽(?:\d|$)|醬(?:油|汁|料|包)?$|醬[\d\s]|魚露|蠔油|醋|鹽(?:巴|粒)?$|胡椒|香料|調味|咖哩粉|咖哩塊|雞粉|雞精粉|高湯|湯底|味醂|米酒|料酒|味噌|芥末|孜然|八角|肉桂|橄欖油|沙拉油|食用油|麻油|香油|砂糖|冰糖|黑糖|紅糖|白糖|蜂蜜|辣油|辣粉|辣椒粉|辣椒油|味精|柴魚粉/],["零食",/棉花糖|餅乾|洋芋片|薯片|爆米花|巧克力|糖果|布丁|果凍|冰淇淋|堅果|瓜子|花生糖|鳳梨酥|蛋捲|肉乾|魚酥/],["飲料",/豆漿|米漿|燕麥奶|椰奶|杏仁奶|奶茶|咖啡|可可粉|茶葉|紅茶|綠茶|烏龍茶|汽水|氣泡水|飲用水|礦泉水|果汁|柳橙汁|啤酒|紅酒|白酒|運動飲料/],["豆製品",/豆腐|豆乾|豆干|豆皮|腐竹|素肉|素雞|素鴨|百頁|百葉豆腐/],["主食",/吐司|土司|貝果|麵包|饅頭|烏龍麵|泡麵|拉麵|義大利麵|冬粉|米粉|米線|麵條|麵粉|餃子皮|餃皮|水餃|餛飩|年糕|白米|糙米|糯米|燕麥|麥片|白飯|米飯|地瓜(?!葉)|馬鈴薯|餅皮/],["蛋奶",/雞蛋|鴨蛋|鵪鶉蛋|皮蛋|鹹蛋|牛奶|鮮奶|奶油|起司|乳酪|優格|優酪乳|煉乳|蛋液|奶粉/],["肉類",/(?:洋蔥|番茄)豬肉|番茄牛腩/],["海鮮",/蒜蓉蝦/],["蔬菜",/高麗菜|白菜|青江菜|小松菜|空心菜|菠菜|花椰菜|青花菜|地瓜葉|大陸妹|萵苣|茼蒿|芥藍|油菜|娃娃菜|包心菜|水蓮|菇|木耳|洋蔥|青蔥|大蔥|蒜|薑|韭菜|芹菜|香菜|九層塔|羅勒|薄荷|玉米|甜椒|青椒|彩椒|辣椒|番茄|蕃茄|茄子|小黃瓜|大黃瓜|櫛瓜|絲瓜|苦瓜|南瓜|冬瓜|胡蘿蔔|紅蘿蔔|白蘿蔔|筍|竹筍|蘆筍|蓮藕|芋頭|秋葵|豆芽|毛豆|豌豆|四季豆|荷蘭豆|甜豆|花生|海帶|紫菜|海苔/],["水果",/水果|蘋果|香蕉|芭樂|鳳梨|奇異果|柳丁|橘子|橙子|葡萄|草莓|藍莓|西瓜|哈密瓜|香瓜|木瓜|芒果|水蜜桃|百香果|火龍果|檸檬|柚子|酪梨|櫻桃|荔枝|龍眼|蓮霧|梨子|水梨/],["海鮮",/吳郭魚|鮭魚|鯖魚|鱈魚|鯛魚|鮪魚|秋刀魚|虱目魚|鱸魚|魚片|魚排|魚丸|魚板|蝦|蟹|蛤蜊|蛤蠣|蛤仔|扇貝|干貝|蛎|牡蠣|蚵|透抽|小卷|中卷|花枝|魷魚|章魚|海鮮/],["肉類",/牛肉|牛排|牛腩|牛肋|牛五花|豬肉|豬排|豬五花|豬梅花|豬里肌|豬絞肉|雞肉|雞腿|雞胸|雞翅|雞柳|全雞|鴨肉|鴨胸|鴨腿|羊肉|羊排|培根|香腸|火腿|熱狗|貢丸|肉丸|絞肉|排骨|五花肉|里肌肉|梅花肉|梅花豬|肉片/]],Le={肉:"肉類",雞:"肉類",豬:"肉類",牛:"肉類",魚:"海鮮",蛋:"蛋奶",奶:"蛋奶",米:"主食",麵:"主食",水:"飲料",茶:"飲料",鹽:"調味料",糖:"調味料",油:"調味料",蔬菜:"蔬菜"};function y(c){let K=pe(c);if(Object.hasOwn(Le,K))return Le[K];return He.find(([,R])=>R.test(K))?.[0]||"其他"}function b(c){let K=new Map;for(let ee of c.meals)for(let ae of n(ee.ingredients)){let le=pe(ae);if(!K.has(le))K.set(le,{name:ae,mealIds:[]});K.get(le).mealIds.push(ee.id)}let R=new Map,Y=(ee)=>ee.source==="meal"&&!ee.done?1:0;for(let ee of[...c.shopping].sort((ae,le)=>Y(ae)-Y(le)))for(let ae of n(ee.name)){let le=pe(ae);if(!R.has(le))R.set(le,ee.id)}let X=new Set,ne=0,W=0,te=[];for(let ee of c.shopping){let ae=n(ee.name).map(pe),le=[...new Set(ae.filter((ce)=>R.get(ce)===ee.id).flatMap((ce)=>K.get(ce)?.mealIds||[]))];if(ee.source==="meal"&&!le.length&&!ee.done){W++;continue}let we=!ae.some((ce)=>K.has(ce))&&Boolean(ee.recipeRemoved||ee.mealIds?.length),he={...ee,mealIds:le};if(we||ee.recipeRemoved!==void 0)he.recipeRemoved=we;if(ee.source==="meal"&&ee.done&&!le.length)he.source="manual";te.push(he);for(let ce of ae)X.add(ce)}for(let[ee,ae]of K){if(X.has(ee))continue;te.push({id:globalThis.crypto.randomUUID(),name:ae.name,quantity:"數量待確認",category:y(ae.name),assignee:"",done:!1,source:"meal",mealIds:ae.mealIds}),ne++}if(te.length>1000)throw Error("採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。");let re=JSON.stringify(te)!==JSON.stringify(c.shopping);if(re)c.shopping=te;return{changed:re,added:ne,removed:W}}var v=[["hotpot","壽喜燒／火鍋"],["bbq","烤肉串燒"],["toast","熱壓吐司"],["curry","咖哩飯"],["pasta","義大利麵"],["breakfast","貝果早餐"],["salad","蔬菜沙拉"],["custom","通用餐盤"]],x=[{id:"sukiyaki",title:"暖暖壽喜燒",imageKind:"hotpot",ingredients:"牛肉片、板豆腐、高麗菜、香菇、洋蔥、壽喜燒醬",notes:"先煎洋蔥，再加入醬汁和食材慢慢煮。"},{id:"hotpot",title:"什錦火鍋",imageKind:"hotpot",ingredients:"豬肉片、高麗菜、金針菇、板豆腐、玉米、蛤蜊、高湯",notes:"依食材熟成時間分批下鍋，生熟食分開夾取。"},{id:"bbq",title:"星空炭火燒烤",imageKind:"bbq",ingredients:"雞腿肉、香腸、玉米、甜椒、櫛瓜、烤肉醬",notes:"肉類與蔬菜分開處理，雞肉要烤熟。"},{id:"toast",title:"起司熱壓吐司",imageKind:"toast",ingredients:"吐司、雞蛋、起司、火腿、奶油",notes:"吐司外側薄抹奶油，夾入熟蛋與配料後熱壓。"},{id:"curry",title:"野炊雞肉咖哩飯",imageKind:"curry",ingredients:"雞腿肉、馬鈴薯、紅蘿蔔、洋蔥、咖哩塊、白米",notes:"先炒香洋蔥與雞肉，燉熟根莖後加入咖哩塊。"},{id:"pasta",title:"番茄義大利麵",imageKind:"pasta",ingredients:"義大利麵、番茄、洋蔥、大蒜、絞肉、番茄醬、橄欖油",notes:"煮麵水留一小杯，拌醬時調整濃稠度。"},{id:"breakfast",title:"貝果早安盤",imageKind:"breakfast",ingredients:"貝果、雞蛋、奶油、蘋果、鮮奶、咖啡豆",notes:"烤熱貝果，搭配煎蛋、水果與喜歡的飲品。"},{id:"salad",title:"清爽野餐沙拉",imageKind:"salad",ingredients:"萵苣、小黃瓜、番茄、玉米、雞蛋、橄欖油",notes:"蔬菜洗淨瀝乾，出餐前再拌入調味。"}],q={"肉類":["牛肉片","豬肉片","雞腿肉","雞胸肉","香腸","培根","火腿","絞肉"],"海鮮":["鮮蝦","蛤蜊","鮭魚","花枝","干貝"],"蔬菜":["高麗菜","洋蔥","香菇","金針菇","玉米","甜椒","番茄","紅蘿蔔","小黃瓜","櫛瓜","萵苣","大蒜"],"蛋奶":["雞蛋","起司","鮮奶","奶油","優格"],"豆製品":["板豆腐","豆皮","豆乾"],"主食":["白米","吐司","貝果","義大利麵","烏龍麵","馬鈴薯"],"調味料":["壽喜燒醬","烤肉醬","咖哩塊","番茄醬","醬油","橄欖油","鹽","胡椒","高湯"],"水果飲料":["蘋果","香蕉","葡萄","咖啡豆","豆漿","飲用水"],"點心":["棉花糖","餅乾","巧克力"]};function N(c,K){return n(`${c||""}、${K||""}`).join("、")}function B(c,K){let R=x.find((Y)=>Y.id===K);if(!R)throw Error("請先選擇常用料理範本。");return{...c,title:R.title,notes:R.notes,imageKind:R.imageKind,ingredients:N(c.ingredients,R.ingredients)}}function Z(c){if(v.some(([Y])=>Y===c.imageKind))return c.imageKind;let K=String(c.title||"");for(let[Y,X]of[[/壽喜燒|火鍋|涮|湯鍋/,"hotpot"],[/烤肉|燒烤|串燒|串烤|烤雞|烤魚|烤玉米/,"bbq"],[/吐司|土司|三明治/,"toast"],[/咖哩/,"curry"],[/義大利麵|意大利麵|義式麵/,"pasta"],[/沙拉/,"salad"],[/貝果|早餐|早安/,"breakfast"]])if(Y.test(K))return X;let R=n(c.ingredients);if(R.some((Y)=>/貝果/.test(Y)))return"breakfast";if(R.some((Y)=>/吐司|土司/.test(Y)))return"toast";if(R.some((Y)=>/咖哩/.test(Y)))return"curry";if(R.some((Y)=>/義大利麵/.test(Y)))return"pasta";if(R.some((Y)=>/壽喜燒醬|火鍋湯底/.test(Y)))return"hotpot";if(R.some((Y)=>/烤肉醬/.test(Y)))return"bbq";return"custom"}var Ee="ggc-local-demo-v1",M="ggc-local-demo-v2",d="ggc-local-theme",T=[["schedule","行程表"],["meals","料理菜單"],["shopping","採買清單"],["gear","裝備分工"],["expenses","分帳記帳"]];function F(c){return T.some(([K])=>K===c)?c:"schedule"}var t=["coral","blue","green","yellow","lavender","peach"],L=()=>globalThis.crypto?.randomUUID?.()||`id-${Date.now()}-${Math.random().toString(36).slice(2)}`,e=(c)=>String(c??"").replace(/[&<>"']/g,(K)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[K]),s=(c)=>new Date(`${c}T12:00:00`).toLocaleDateString("zh-TW",{month:"numeric",day:"numeric"}),A=(c)=>new Date(`${c}T12:00:00`).toLocaleDateString("zh-TW",{weekday:"short"}),me=(c)=>c.toISOString().slice(0,10);function r(c,K){let R=[],Y=new Date(`${c}T00:00:00Z`),X=new Date(`${K}T00:00:00Z`);if(!Number.isFinite(+Y)||!Number.isFinite(+X)||X<Y||me(Y)!==c||me(X)!==K||+X-+Y>2592000000)return R;for(let ne=Y;ne<=X&&R.length<31;ne=new Date(+ne+86400000))R.push(me(ne));return R}var i=(c,K)=>c.people.find((R)=>R.id===K)?.name||"待分配";function w(c=new Date){let K=new Date(c.getTime()-c.getTimezoneOffset()*60000).toISOString().slice(0,10);return{schema:1,revision:0,currentUser:"me",joined:!0,trip:{title:"我的露營旅行",destination:"",startDate:K,endDate:K,description:"",note:""},people:[{id:"me",name:"我",color:"coral",role:"旅行召集人"}],activities:[],meals:[],shopping:[],gear:[],vehicles:[],events:[],departed:[]}}function l(c){if(!c||c.schema!==1||!c.trip||!Array.isArray(c.people)||!c.people.length||c.people.length>100)return!1;if(!Number.isSafeInteger(c.revision)||c.revision<0||typeof c.joined!=="boolean")return!1;if(!["title","destination","startDate","endDate","description","note"].every((W)=>typeof c.trip[W]==="string"&&c.trip[W].length<=5000))return!1;let K=r(c.trip.startDate,c.trip.endDate);if(!K.length||!c.trip.title.trim())return!1;let R={people:["id","name","color","role"],activities:["id","date","time","title","type","location","note"],meals:["id","date","slot","title","cookId","ingredients","notes"],shopping:["id","name","quantity","category","assignee"],gear:["id","name","quantity","scope","assignee"],vehicles:["id","name","driver","meeting"],events:["id","text","at","actor"]};for(let[W,te]of Object.entries(R)){if(!Array.isArray(c[W])||c[W].length>1000)return!1;if(!c[W].every((re)=>re&&te.every((ee)=>typeof re[ee]==="string"&&re[ee].length<=5000)&&re.id.length>0))return!1;if(new Set(c[W].map((re)=>re.id)).size!==c[W].length)return!1}let Y=new Set(c.people.map((W)=>W.id)),X=(W)=>W===""||Y.has(W),ne=(W)=>Array.isArray(W)&&W.length===new Set(W).size&&W.every((te)=>typeof te==="string"&&Y.has(te));return Y.has(c.currentUser)&&c.people.every((W)=>W.name.trim()&&t.includes(W.color))&&c.gear.every((W)=>["personal","shared"].includes(W.scope)&&X(W.assignee)&&ne(W.ready)&&(W.scope!=="shared"||W.ready.every((te)=>te===W.assignee)))&&c.activities.every((W)=>K.includes(W.date)&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(W.time)&&["meet","market","camp","meal","night","travel"].includes(W.type)&&ne(W.people)&&k(W,c.vehicles)&&typeof W.done==="boolean")&&c.shopping.every((W)=>typeof W.done==="boolean"&&X(W.assignee)&&f.includes(W.category)&&(W.recipeRemoved===void 0||typeof W.recipeRemoved==="boolean")&&(W.source===void 0||["meal","manual"].includes(W.source))&&(W.mealIds===void 0||Array.isArray(W.mealIds)&&W.mealIds.length===new Set(W.mealIds).size&&W.mealIds.every((te)=>c.meals.some((re)=>re.id===te))))&&c.meals.every((W)=>(W.imageKind===void 0||v.some(([te])=>te===W.imageKind))&&K.includes(W.date)&&X(W.cookId)&&Number.isInteger(W.servings)&&W.servings>0&&W.servings<=100)&&c.vehicles.every((W)=>X(W.driver)&&ne(W.passengers)&&!W.passengers.includes(W.driver)&&Number.isInteger(W.seats)&&W.seats>0&&W.seats<=9&&W.passengers.length+1<=W.seats)&&c.events.every((W)=>Number.isFinite(Date.parse(W.at)))&&ne(c.departed)}function S(c){let K,R=!1;try{if(K=c.getItem(M),K===null)K=c.getItem(Ee),R=K!==null}catch{return{state:w(),status:"unavailable"}}if(K===null)return{state:w(),status:"empty"};try{let Y=JSON.parse(K);if(l(Y))return{state:Y,status:"ok",migratedFromLegacy:R}}catch{}return{state:w(),status:"invalid",raw:K}}function m(c,K){try{return c.setItem(M,JSON.stringify(K)),!0}catch{return!1}}function p(c,K=c.currentUser){return c.gear.filter((R)=>R.scope==="personal"||R.assignee===K)}function C(c,K=c.currentUser){return p(c,K).filter((R)=>R.ready.includes(K)).length}function g(c){return c.gear.filter((K)=>K.scope==="shared"&&!K.assignee)}function G(c,K){let R=c.gear.find((Y)=>Y.id===K);if(!R||!p(c).some((Y)=>Y.id===K))return!1;if(R.ready=R.ready.includes(c.currentUser)?R.ready.filter((Y)=>Y!==c.currentUser):[...R.ready,c.currentUser],!R.ready.includes(c.currentUser))c.departed=c.departed.filter((Y)=>Y!==c.currentUser);return!0}function V(c,K,R){let Y=c.shopping.find((X)=>X.id===K);if(!Y||typeof R!=="string"||R&&!c.people.some((X)=>X.id===R)||Y.assignee===R)return!1;return Y.assignee=R,Y.source="manual",!0}function z(c,K,R){let Y=c.gear.find((X)=>X.id===K);if(!Y||R&&!c.people.some((X)=>X.id===R))return!1;return Y.assignee=R,Y.ready=[],c.departed=[],!0}function _(c){return C(c)===p(c).length&&g(c).length===0}function Q(c){let K=c.gear.reduce((Y,X)=>Y+(X.scope==="personal"?c.people.length:1),0),R=c.gear.reduce((Y,X)=>Y+(X.scope==="personal"?X.ready.length:Number(!!X.assignee&&X.ready.includes(X.assignee))),0);return{shoppingDone:c.shopping.filter((Y)=>Y.done).length,shoppingTotal:c.shopping.length,gearDone:R,gearTotal:K}}function P(c,K){c.revision=(c.revision||0)+1,c.events.unshift({id:L(),text:K,actor:i(c,c.currentUser),at:new Date().toISOString()}),c.events=c.events.slice(0,50)}var u=(c)=>String(c??"").normalize("NFKC").trim().replace(/\s+/gu," "),ye=(c)=>u(c).replace(/\p{Default_Ignorable_Code_Point}/gu,"").toLocaleLowerCase("zh-TW");function O(c,K,R=""){let Y=u(K),X=u(R);if(!ye(Y).trim())throw Error("請填寫名字或暱稱，不能只有空白。");let ne=Y.replace(/(\p{Extended_Pictographic}\p{Variation_Selector}?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu,"$1");if(/[\p{Cf}\p{Cc}]/u.test(ne))throw Error("名字不能包含隱藏控制字元。");if([...Y].length>30)throw Error("名字最多 30 個字。");if([...X].length>60)throw Error("小隊角色最多 60 個字。");if(c.people.some((te)=>ye(te.name)===ye(Y)))throw Error("這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。");if(c.people.length>=100)throw Error("小隊最多 100 位旅伴，目前已額滿。");let W={id:L(),name:Y,role:X||"新加入的旅伴",color:t[c.people.length%t.length]};return{state:{...c,people:[...c.people,W],departed:[]},person:W}}var J={paper:"#fffcf6",ink:"#3e3a39",coral:"#efa28f",yellow:"#f6d27a",sky:"#b7dbe5",green:"#b9cda5"},ie=`stroke="${J.ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;function Te(c){return String(c??"").replace(/[&<>"'`]/g,(K)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;"})[K])}function de(c,K,R,Y,X="",ne={}){let W=Te([X,R].filter(Boolean).join(" ")),te=["xMidYMid meet","xMidYMid slice","xMidYMax meet"].includes(ne.preserveAspectRatio)?ne.preserveAspectRatio:"xMidYMid meet",re=ne.transparentBackground?Y.replace(/^\s*<rect\b[^>]*\/>/,""):Y,ee=ne.fullFrame?"width:100%;height:100%;max-width:none":"max-width:100%;height:auto";return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c} ${K}" preserveAspectRatio="${te}" class="${W}" aria-hidden="true" focusable="false" fill="none" style="display:block;${ee}">${re}</svg>`}var ue=(c,K,R)=>`
  <g class="scene-layer scene-sun"><g ${ie}>
    <circle cx="${c}" cy="${K}" r="${R}" fill="${J.yellow}"/>
    ${[0,45,90,135,180,225,270,315].map((Y)=>{let X=Y*Math.PI/180,ne=c+Math.cos(X)*(R+8),W=K+Math.sin(X)*(R+8),te=c+Math.cos(X)*(R+18),re=K+Math.sin(X)*(R+18);return`<line x1="${ne.toFixed(1)}" y1="${W.toFixed(1)}" x2="${te.toFixed(1)}" y2="${re.toFixed(1)}"/>`}).join("")}
  </g></g>`,ge=(c,K,R=1)=>`
  <g class="scene-layer scene-cloud"><path transform="translate(${c} ${K}) scale(${R})" d="M0 20 Q0 6 14 8 Q20 -4 34 2 Q48 -2 50 12 Q62 12 62 22 Q62 30 52 30 H8 Q0 30 0 20 Z" fill="${J.paper}" ${ie}/></g>`,se=(c,K,R,Y=J.green)=>{let X=R*0.42;return`
  <g class="scene-layer scene-tree"><g ${ie}>
    <line x1="${c}" y1="${K}" x2="${c}" y2="${K-R*0.18}"/>
    <path d="M${c} ${K-R} L${c+X*0.62} ${K-R*0.58} H${c+X*0.32} L${c+X} ${K-R*0.18} H${c-X} L${c-X*0.32} ${K-R*0.58} H${c-X*0.62} Z" fill="${Y}"/>
  </g></g>`},Qe=(c,K,R=1)=>`
  <g class="scene-layer scene-van"><g class="scene-layer scene-van-bounce"><g transform="translate(${c} ${K}) scale(${R})" ${ie}>
    <path d="M10 70 V28 Q10 8 32 8 H150 Q170 8 178 28 L192 54 Q196 60 196 70 V84 Q196 90 190 90 H16 Q10 90 10 84 Z" fill="${J.yellow}"/>
    <path d="M10 56 H196" />
    <rect x="28" y="22" width="40" height="26" rx="6" fill="${J.sky}"/>
    <rect x="80" y="22" width="40" height="26" rx="6" fill="${J.sky}"/>
    <path d="M134 22 H160 Q166 22 170 30 L180 48 H134 Z" fill="${J.sky}"/>
    <line x1="126" y1="56" x2="126" y2="84"/>
    <line x1="114" y1="66" x2="120" y2="66"/>
    <path d="M24 60 H112" stroke="${J.coral}" stroke-width="6"/>
    <path d="M40 8 V0 H120 V8"/>
    <circle cx="190" cy="66" r="3" fill="${J.paper}"/>
    <circle cx="50" cy="90" r="16" fill="${J.ink}"/>
    <circle cx="50" cy="90" r="6" fill="${J.paper}"/>
    <circle cx="158" cy="90" r="16" fill="${J.ink}"/>
    <circle cx="158" cy="90" r="6" fill="${J.paper}"/>
  </g></g></g>`,Ze=(c,K,R=1)=>`
  <g transform="translate(${c} ${K}) scale(${R})" ${ie}>
    <path d="M0 100 L70 0 L140 100 Z" fill="${J.coral}"/>
    <path d="M70 0 L48 100 H92 Z" fill="${J.paper}"/>
    <line x1="70" y1="0" x2="70" y2="100"/>
    <line x1="70" y1="0" x2="62" y2="-12"/>
    <line x1="70" y1="0" x2="78" y2="-12"/>
    <line x1="-14" y1="100" x2="154" y2="100"/>
  </g>`;function Se(c,K){return de(680,340,c,`
  <rect x="0" y="0" width="680" height="340" fill="var(--soft, ${J.paper})"/>
  ${ue(560,72,28)}
  ${ge(80,50,1)}
  ${ge(330,34,0.8)}
  <g ${ie}>
    <path d="M-10 250 L130 96 L210 170 L320 60 L440 190 L520 120 L690 260 Z" fill="${J.sky}"/>
    <path d="M320 60 L292 92 L310 88 L322 104 L338 86 L352 96 Z" fill="${J.paper}"/>
    <path d="M130 96 L110 118 L126 114 L136 126 L150 114 Z" fill="${J.paper}"/>
    <path d="M-10 262 Q90 222 200 246 T420 238 T690 244 V350 H-10 Z" fill="${J.green}"/>
    <path d="M-10 300 Q140 272 300 292 T690 286 V350 H-10 Z" fill="${J.paper}"/>
  </g>
  ${se(250,258,92)}
  ${se(286,252,70)}
  ${se(430,250,84)}
  ${se(640,262,100)}
  ${Qe(40,184,0.98)}
  ${Ze(468,196,1)}
  <g ${ie}>
    <g class="scene-layer scene-flame"><path d="M370 300 Q376 286 384 300" fill="${J.coral}"/></g>
    <line x1="362" y1="304" x2="392" y2="304"/>
  </g>`,"illustration illustration--camp",K)}function _e(c,K){return de(680,250,c,`
  <rect x="0" y="0" width="680" height="250" fill="${J.paper}"/>
  ${K.hideSun?"":ue(110,64,24)}
  ${ge(470,36,0.9)}
  <g ${ie}>
    <path d="M-10 170 L120 92 L200 140 L300 70 L420 150 L520 96 L690 176 Z" fill="${J.sky}"/>
    <path d="M-10 178 Q160 150 340 172 T690 168 V260 H-10 Z" fill="${J.green}"/>
    <path d="M-10 214 H690" />
    <path d="M40 230 H110 M180 230 H250 M320 230 H390 M460 230 H530 M600 230 H660"/>
  </g>
  ${se(70,182,70)}
  ${se(600,180,80)}
  ${se(636,184,58)}
  ${Qe(240,108,1)}
  <g ${ie}>
    <line x1="200" y1="150" x2="224" y2="150"/>
    <line x1="190" y1="170" x2="222" y2="170"/>
    <line x1="206" y1="190" x2="226" y2="190"/>
  </g>`,"illustration illustration--travel",K)}function qe(c,K){return de(680,250,c,`
  <rect x="0" y="0" width="680" height="250" fill="${J.paper}"/>
  ${ue(548,58,25)}
  ${ge(92,40,0.8)}
  <g ${ie}>
    <path d="M-10 172 L112 94 L202 154 L318 76 L430 154 L520 104 L690 176 Z" fill="${J.sky}"/>
    <path d="M-10 176 Q150 154 330 174 T690 168 V260 H-10 Z" fill="${J.sky}"/>
    <path d="M250 178 Q340 170 430 178 M205 193 Q330 184 470 194 M270 211 Q340 205 410 212 M130 228 Q300 219 520 230" fill="none"/>
    <path d="M-10 170 Q90 150 178 172 L210 250 H-10 Z" fill="${J.green}"/>
    <path d="M690 174 Q588 150 504 172 L470 250 H690 Z" fill="${J.green}"/>
  </g>
  ${se(82,174,76)}
  ${se(122,168,56)}
  ${se(596,174,68)}
  <g ${ie}><path d="M302 188 Q340 174 378 188 L368 212 H312 Z" fill="${J.coral}"/><path d="M302 188 L340 156 L378 188 Z" fill="${J.yellow}"/><line x1="340" y1="156" x2="340" y2="212"/></g>`,"illustration illustration--lake",K)}function De(c,K){return de(680,250,c,`
  <rect x="0" y="0" width="680" height="250" fill="${J.paper}"/>
  ${ue(552,52,23)}
  <g ${ie}>
    <path d="M-10 150 Q140 112 300 152 T690 140 V260 H-10 Z" fill="${J.green}"/>
    <path d="M0 250 Q198 196 350 214 Q500 188 680 250 Z" fill="${J.yellow}"/>
    <path d="M272 250 Q320 211 350 214 Q383 222 408 250" fill="none"/>
  </g>
  ${se(52,188,140)}
  ${se(110,178,108)}
  ${se(174,190,145)}
  ${se(508,182,128)}
  ${se(574,192,154)}
  ${se(638,180,112)}
  <g ${ie}>
    <path d="M278 196 L340 140 L402 196 Z" fill="${J.coral}"/>
    <path d="M340 140 L320 196 H360 Z" fill="${J.paper}"/>
    <line x1="264" y1="196" x2="416" y2="196"/>
    <path d="M438 226 Q444 210 450 226 M432 230 H456" fill="${J.coral}"/>
  </g>`,"illustration illustration--forest",K)}function Ae(c,K){return de(680,250,c,`
  <rect x="0" y="0" width="680" height="250" fill="${J.paper}"/>
  ${ue(540,56,27)}
  <g ${ie}>
    <path d="M-10 140 Q140 120 270 142 T690 136 V210 H-10 Z" fill="${J.sky}"/>
    <path d="M-10 154 Q120 140 250 158 T690 150 M-10 178 Q130 164 280 181 T690 174" fill="none"/>
    <path d="M-10 188 Q180 166 330 190 T690 178 V260 H-10 Z" fill="${J.yellow}"/>
    <path d="M510 250 Q532 202 568 180 Q607 202 628 250 Z" fill="${J.coral}"/>
    <path d="M568 180 V250" fill="none"/>
    <path d="M62 192 Q68 172 74 192 M56 196 H80" fill="${J.green}"/>
    <path d="M600 100 Q586 145 604 178 M600 126 Q574 116 568 103 M600 139 Q626 122 639 112 M596 124 Q590 105 596 91" fill="none"/>
  </g>
  <path d="M600 101 Q578 93 568 103 Q582 118 599 118 M600 126 Q622 110 639 112 Q633 130 600 141 M598 124 Q582 103 596 91 Q608 105 602 126" fill="${J.green}" stroke="${J.ink}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="142" cy="210" r="13" fill="${J.paper}" ${ie}/><path d="M130 210 H154 M142 197 V223" ${ie}/>
  <path d="M264 215 Q280 197 296 215 M280 201 V229" ${ie}/><path d="M260 230 H300" ${ie}/>`,"illustration illustration--beach",K)}function Oe(c,K){return de(680,250,c,`
  <rect x="0" y="0" width="680" height="250" fill="${J.paper}"/>
  ${ge(84,48,0.8)}
  <g ${ie}>
    <path d="M-10 172 L112 100 L210 160 L330 72 L448 164 L538 106 L690 178 Z" fill="${J.sky}"/>
    <path d="M-10 180 Q160 158 340 178 T690 170 V260 H-10 Z" fill="${J.green}"/>
    <path d="M284 178 A56 56 0 0 1 396 178" fill="${J.yellow}"/>
    <path d="M-10 188 Q160 180 340 190 T690 184 V260 H-10 Z" fill="${J.sky}"/>
    <path d="M270 207 H410 M244 224 H436 M296 240 H384" fill="none"/>
    <path d="M-10 212 Q150 200 300 215 T690 208 V260 H-10 Z" fill="${J.green}"/>
  </g>
  ${se(74,190,80)}
  ${se(604,188,94)}
  <g ${ie}><path d="M284 194 Q340 178 396 194 L384 220 H296 Z" fill="${J.coral}"/><path d="M284 194 L340 162 L396 194 Z" fill="${J.yellow}"/><line x1="340" y1="162" x2="340" y2="220"/></g>`,"illustration illustration--sunrise",K)}function Ke(c){return de(240,200,c,`
  <rect x="0" y="0" width="240" height="200" rx="20" fill="${J.paper}"/>
  <g ${ie}>
    <path d="M96 44 Q86 30 96 18 M120 44 Q110 30 120 18 M144 44 Q134 30 144 18"/>
    <line x1="62" y1="62" x2="178" y2="62"/>
    <path d="M70 62 V112 Q70 136 96 136 H144 Q170 136 170 112 V62" fill="${J.coral}"/>
    <path d="M70 76 H52 M170 76 H188"/>
    <path d="M86 92 H154" stroke="${J.paper}"/>
    <path d="M80 182 L120 146 L160 182" />
    <path d="M100 182 L120 160 L140 182" />
    <path d="M108 168 Q120 140 132 168 Q120 180 108 168 Z" fill="${J.yellow}"/>
    <line x1="56" y1="184" x2="184" y2="184"/>
  </g>`,"illustration illustration--meal")}function Ne(c){return de(240,200,c,`
  <rect x="0" y="0" width="240" height="200" rx="20" fill="${J.paper}"/>
  <g ${ie}>
    <path d="M104 74 Q100 40 120 40 Q140 40 136 74" />
    <path d="M124 60 Q128 30 150 26 Q146 52 128 62" fill="${J.green}"/>
    <rect x="132" y="44" width="24" height="44" rx="6" fill="${J.sky}"/>
    <circle cx="96" cy="68" r="16" fill="${J.coral}"/>
    <line x1="96" y1="52" x2="100" y2="44"/>
    <path d="M70 74 H170 L160 172 Q159 180 150 180 H90 Q81 180 80 172 Z" fill="${J.yellow}"/>
    <path d="M92 108 H148"/>
    <line x1="48" y1="182" x2="192" y2="182"/>
  </g>`,"illustration illustration--market")}function Ve(c,K){let R=[[60,50],[150,30],[250,70],[380,40],[470,80],[600,34],[640,96],[320,110]].map(([Y,X])=>`<path d="M${Y} ${X-6} V${X+6} M${Y-6} ${X} H${Y+6}"/>`).join("");return de(680,300,c,`
  <rect x="0" y="0" width="680" height="300" fill="${J.ink}"/>
  <g class="scene-layer scene-cloud" stroke="${J.paper}" stroke-width="3" stroke-linecap="round">${R}</g>
  <g class="scene-layer scene-sun"><path d="M560 40 A34 34 0 1 0 596 92 A26 26 0 1 1 560 40 Z" fill="${J.yellow}" stroke="${J.paper}" stroke-width="3" stroke-linejoin="round"/></g>
  <g stroke="${J.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-10 220 L120 110 L210 180 L330 90 L450 190 L540 140 L690 230 Z" fill="${J.sky}" fill-opacity="0.35"/>
    <path d="M-10 236 Q160 206 340 228 T690 224 V310 H-10 Z" fill="${J.green}" fill-opacity="0.55"/>
  </g>
  <g stroke="${J.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M90 236 L130 170 L170 236 Z" fill="${J.ink}"/>
    <path d="M560 240 L600 160 L640 240 Z" fill="${J.ink}"/>
    <path d="M300 266 L370 176 L440 266 Z" fill="${J.coral}"/>
    <path d="M370 176 L352 266 H388 Z" fill="${J.yellow}"/>
    <line x1="284" y1="266" x2="456" y2="266"/>
    <path d="M498 270 L512 254 L526 270" />
    <path d="M504 262 Q512 236 520 262 Q512 272 504 262 Z" fill="${J.coral}"/>
  </g>`,"illustration illustration--night",K)}var ve={camp:Se,travel:_e,lake:qe,forest:De,beach:Ae,sunrise:Oe,meal:Ke,market:Ne,night:Ve};function a(c="camp",K="",R={}){return(Object.prototype.hasOwnProperty.call(ve,c)?ve[c]:Se)(K,R)}function h(){return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44" aria-hidden="true" focusable="false" fill="none" class="logo-mark">
  <rect x="2" y="2" width="40" height="40" rx="12" fill="${J.paper}" stroke="${J.ink}" stroke-width="2.5"/>
  <circle cx="31" cy="13" r="4.5" fill="${J.yellow}" stroke="${J.ink}" stroke-width="2"/>
  <path d="M9 33 L20 15 L31 33 Z" fill="${J.coral}" stroke="${J.ink}" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M20 15 L17 33 H23 Z" fill="${J.paper}" stroke="${J.ink}" stroke-width="2" stroke-linejoin="round"/>
  <line x1="7" y1="33" x2="37" y2="33" stroke="${J.ink}" stroke-width="2.5" stroke-linecap="round"/>
</svg>`}var $e="ggc-scene-motion",Ce="(prefers-reduced-motion: reduce)",be="[data-scene-motion-toggle]",Re="[data-motion-reduced-note]",oe=null,fe=!1,xe=null;function Pe(c){try{let K=c?.getItem($e);if(K==="paused"||K==="playing")return K}catch{}return xe}function je(c,K){xe=K;try{c?.setItem($e,K)}catch{}}function Ue(c){return!!c?.matches}var Ie=(c)=>c==="paused"?"播放動畫":"暫停動畫";function Me(){if(!oe)return"static";if(Ue(oe.query))return"reduced";return fe?"paused":"running"}function o(){if(!oe)return"static";fe=Pe(oe.storage)==="paused";let c=Me();oe.root.dataset.sceneMotion=c;for(let K of oe.doc.querySelectorAll(be))K.hidden=c==="reduced",K.setAttribute("aria-label",Ie(c));for(let K of oe.doc.querySelectorAll(Re))K.hidden=c!=="reduced";return c}function ze(c){if(!oe)return"static";return je(oe.storage,c?"paused":"playing"),o()}function E(c={}){let K=c.document??globalThis.document;if(!K)return"static";if(oe?.doc===K)return o();if(oe)Fe();let R=c.window??K.defaultView??globalThis,Y=c.storage;if(Y===void 0)try{Y=R.localStorage}catch{Y=null}let X=c.reducedMotion??R.matchMedia?.(Ce)??null,ne=(re)=>{if(!re.target?.closest?.(be)||Me()==="reduced")return;re.preventDefault(),ze(!fe)},W=(re)=>{if(re.key===null||re.key===$e)o()},te=()=>o();return K.addEventListener("click",ne),R.addEventListener?.("storage",W),X?.addEventListener?.("change",te),oe={doc:K,win:R,root:K.documentElement,storage:Y,query:X,onClick:ne,onStorage:W,onQuery:te},o()}function Fe(){if(!oe)return;oe.doc.removeEventListener("click",oe.onClick),oe.win.removeEventListener?.("storage",oe.onStorage),oe.query?.removeEventListener?.("change",oe.onQuery),delete oe.root.dataset.sceneMotion,oe=null,fe=!1,xe=null}var Ye='<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="scene-motion__icon scene-motion__icon--pause"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>',Ge='<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="scene-motion__icon scene-motion__icon--play"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8-5.2a.6.6 0 0 0 0-1l-8-5.2a.6.6 0 0 0-.9.5Z"/></svg>';function j(c="camp",K={}){return`<div class="scene-motion illustration scene-motion--${String(c).replace(/[^a-z]/g,"")||"camp"}">${a(c,"",K)}</div>`}function I(){let c=Me(),K=c==="reduced";return`<section class="motion-settings" aria-label="插畫動畫"><div class="motion-settings__copy"><h3>插畫動畫</h3><p>控制車子與背景動態，只影響這台裝置。</p><p class="motion-settings__note" data-motion-reduced-note${K?"":" hidden"}>依系統減少動態設定，插畫保持靜態。</p></div><button type="button" class="scene-motion__toggle" data-scene-motion-toggle aria-label="${Ie(c)}"${K?" hidden":""}>${Ye}${Ge}<span class="scene-motion__label scene-motion__label--pause">暫停動畫</span><span class="scene-motion__label scene-motion__label--play">播放動畫</span></button></section>`}
export{k,H,U,D,f,n,y,b,v,x,q,N,B,Z,M,d,T,F,t,L,e,s,A,r,i,w,l,S,m,p,C,g,G,V,z,_,Q,P,u,O,a,h,o,E,j,I};
