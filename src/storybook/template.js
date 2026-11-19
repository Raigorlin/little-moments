// Static studio markup injected into the ShadowRoot. It never contains trip data; all user text is set via textContent/value.
export const STUDIO_TEMPLATE = `
<div class="studio" data-studio-root>
<header class="topbar" hidden>
  <div class="brand">
    <strong>旅行繪本</strong>
    <span class="accent">Storybook Trip Studio</span>
  </div>
  <div class="toolbar" role="toolbar" aria-label="海報檢視">
    <button type="button" id="play" aria-pressed="false">播放</button>
    <label class="seek"><span class="sr">動畫時間</span><input type="range" id="seek" min="0" max="16" step="0.04" value="0"></label>
    <output id="seekTime" for="seek" class="accent">0.0s</output>
    <button type="button" id="zoom" aria-pressed="false">實際大小</button>

  </div>
</header>

<p class="print-draft" id="printDraft" hidden>此為尚未儲存的草稿，與伺服器上的行程不同。</p>

<div class="layout" id="layout">
  <main class="stage" aria-label="海報">
    <p id="message" role="status" aria-live="polite" class="message"></p>
    <section class="export card" aria-label="輸出" hidden>
      <div class="export-actions">
        <button type="button" id="generate" class="primary">產生 GIF</button>
        <button type="button" id="cancel" disabled>取消</button>
        <button type="button" id="downloadGif" disabled>下載 GIF</button>
        <button type="button" id="downloadPng">下載 PNG</button>
        <button type="button" id="exportJson">匯出 JSON</button>
      </div>
      <div class="export-status">
        <progress id="progress" max="100" value="0" aria-label="GIF 產生進度"></progress>
        <span id="exportInfo" class="muted"></span>
      </div>
    </section>
    <p class="hint stage-hint" id="previewHint" hidden>點海報上的任一天，就會打開那一天的編輯；也可以用 Tab 鍵選到日期區塊後按 Enter。</p>
    <div class="stage-bar"><button type="button" id="toggleEditor" aria-expanded="true" aria-controls="editorPanel">收起編輯器</button></div>
    <p class="render-fallback" id="renderFallback" role="alert" hidden></p>
    <div class="poster-scroller" id="posterScroller" tabindex="0" aria-label="海報畫布（實際大小時可捲動）">
      <div class="poster-wrap" id="posterWrap">
        <canvas id="poster" role="img" aria-label="旅程海報" aria-describedby="itinerarySummary" width="1600" height="1200"></canvas>
        <div class="preview-targets" id="previewTargets" role="group" aria-label="海報上的日子：選擇以編輯"></div>
      </div>
    </div>
    <p id="previewNote" class="hint" hidden>海報非常長，預覽以較低解析度顯示。</p>
    <section class="journal" id="journal" aria-label="行程手帖"></section>
    <details id="itinerary" class="card itinerary" hidden>
      <summary id="itinerarySummary">文字版完整行程</summary>
      
      <div id="itineraryText"></div>
    </details>
  </main>

  <div class="splitter" id="editorSplitter" role="separator" tabindex="0" aria-orientation="vertical"
       aria-controls="editorPanel" aria-label="調整編輯器寬度（左右方向鍵）" aria-valuemin="320" aria-valuemax="960" aria-valuenow="480"><span class="splitter-grip" aria-hidden="true"></span></div>

  <aside class="editor" id="editorPanel" aria-label="編輯器">
    <form id="editorForm" novalidate>
    <fieldset id="editorFields">
      <legend class="sr">行程編輯</legend>

      <header class="editor-header" id="editorHeader">
        <div class="editor-actions">
          <button type="button" id="saveTrip" class="primary" hidden>儲存行程</button>
          <span id="saveStatus" class="status" aria-live="polite"></span>
          <span class="editor-actions-end">
            <button type="button" id="undoEdit" class="icon" aria-label="復原" title="復原（Ctrl+Z）" disabled>↶<span class="label-text">復原</span></button>
            <button type="button" id="redoEdit" class="icon" aria-label="重做" title="重做（Ctrl+Shift+Z）" disabled>↷<span class="label-text">重做</span></button>
            <button type="button" id="wideEditor" class="icon" hidden aria-pressed="true" aria-label="加寬編輯器" title="加寬編輯器">⇔<span class="label-text">加寬</span></button>
          </span>
        </div>
        <div class="editor-tabs" id="editorTabs" role="tablist" aria-label="編輯項目">
          <button type="button" id="tab-plan" role="tab" data-tab="plan" aria-controls="panel-plan" aria-selected="true">行程</button>
          <button type="button" id="tab-cover" role="tab" data-tab="cover" aria-controls="panel-cover" aria-selected="false" tabindex="-1">封面</button>
          <button type="button" id="tab-assets" role="tab" data-tab="assets" aria-controls="panel-assets" aria-selected="false" tabindex="-1">地點與車</button>
        </div>
        <p class="editor-notice" id="editorNotice" role="status" aria-live="polite"></p>
      </header>

      <section class="panel" id="panel-plan" data-editor-panel="plan" role="tabpanel" aria-labelledby="tab-plan">
        <div class="day-picker">
          <h2 id="dayTabsLabel">編輯哪一天</h2>
          <div class="day-tabs" id="dayTabs" role="group" aria-labelledby="dayTabsLabel"></div>
          <p class="context-note" id="dayContext" aria-live="polite"></p>
        </div>

        <details class="disclosure" id="daySettings">
          <summary>這一天的設定 <span class="hint">標題、日期、地點、增減天數</span></summary>
          <div class="disclosure-body">
            <label for="daySelect">切換日子</label>
            <select id="daySelect"></select>
            <div class="grid4">
              <div><label for="dayTitle">當日標題 <span class="hint">· 海報每日區塊的大字</span></label><input id="dayTitle" autocomplete="off"></div>
              <div><label for="dayDate">日期</label><input id="dayDate" type="date"></div>
              <div><label for="dayLocation">所在地點</label><select id="dayLocation"></select></div>
              <div><label for="dayRoutePosition">路線位置</label>
                <select id="dayRoutePosition"><option value="before">行程之前（出發）</option><option value="after">行程之後（返程）</option></select></div>
            </div>
            <label for="dayArrival">抵達說明 <span class="hint">· 寫在抵達地點旁</span></label>
            <input id="dayArrival" autocomplete="off">
            <div class="route-actions">
              <button type="button" id="addDay">＋ 新增一天</button>
              <button type="button" id="removeDay" class="danger">移除最後一天</button>
            </div>
          </div>
        </details>

        <div class="subnav" role="group" aria-label="這一天要編輯的內容">
          <button type="button" id="section-routes" data-section="routes" aria-pressed="true" aria-controls="routeSection">路線</button>
          <button type="button" id="section-events" data-section="events" aria-pressed="false" aria-controls="eventSection">活動</button>
        </div>

        <section class="plan-section" id="routeSection" aria-labelledby="section-routes">
          <p class="hint" id="routeHelp">每台車可安排途中停靠點，時間可稍後填。</p>
          <ol id="routeList" class="list entries"></ol>
          <button type="button" id="addRoute" class="add">＋ 新增路線</button>
        </section>

        <section class="plan-section" id="eventSection" aria-labelledby="section-events" hidden>
          <p class="hint">依時間排在海報的當日區塊。標示「餐點」的活動來自菜單安排。</p>
          <ol id="eventList" class="list entries"></ol>
          <button type="button" id="addEvent" class="add">＋ 新增活動</button>
        </section>

        <details class="disclosure" id="unassignedSection">
          <summary>未分配採買清單 <span class="hint">採買清單中「待分配」的品項，這裡唯讀</span></summary>
          <div class="disclosure-body">
            <p class="hint">要修改採買項目，請到網站的採買頁；各車途中任務的清單可在路線中編輯。</p>
            <label for="shopping">目前清單</label>
            <textarea id="shopping" rows="5" readonly></textarea>
          </div>
        </details>
      </section>

      <section class="panel" id="panel-cover" data-editor-panel="cover" role="tabpanel" aria-labelledby="tab-cover" hidden>
        <h2>海報封面</h2>
        <p class="hint">這些文字印在海報頂端與底部，不影響每日行程。</p>
        <div class="form-grid cover-grid">
          <div class="span-all">
            <label for="headline">大標題 <span class="hint">· 海報最上方的大字；留空時改用旅程名稱</span></label>
            <input id="headline" autocomplete="off">
          </div>
          <div>
            <label for="title">旅程名稱 <span class="hint">· 大標題下方的小字，和日期並列</span></label>
            <input id="title" autocomplete="off">
          </div>
          <div>
            <label for="startDate">出發日期 <span class="hint">· 改這裡，所有日期一起平移</span></label>
            <input id="startDate" type="date">
          </div>
          <div class="span-all">
            <label for="caption">底部短語 <span class="hint">· 海報最下方左側的一句話</span></label>
            <input id="caption" autocomplete="off">
          </div>
        </div>
      </section>

      <section class="panel" id="panel-assets" data-editor-panel="assets" role="tabpanel" aria-labelledby="tab-assets" hidden>
        <h2>地點</h2>
        <p class="empty" id="noPlaces" hidden>還沒有地點。新增地點後，就能安排路線與停靠點。</p>
        <div class="form-grid" id="placeFields">
          <div>
            <label for="placeSelect">選擇地點</label>
            <select id="placeSelect"></select>
          </div>
          <div>
            <label for="placeName">名稱</label>
            <input id="placeName" autocomplete="off">
          </div>
        </div>
        <div id="placeArt" hidden>
          <label for="placeTemplate">插圖 <span class="hint">· 也可直接點下方縮圖</span></label>
          <select id="placeTemplate"></select>
          <div class="template-grid" id="templateGrid" role="group" aria-label="選擇插圖"></div>
        </div>
        <div class="route-actions">
          <button type="button" id="addPlace">＋ 新增地點</button>
          <button type="button" id="removePlace" class="danger icon trash" aria-label="移除此地點" title="移除此地點"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"/></svg></button>
        </div>

        <h2 class="section-break">車輛</h2>
        <p class="hint">顏色就是海報上這台車的路線顏色。</p>
        <ul id="vehicleList" class="list"></ul>
        <button type="button" id="addVehicle" class="add">＋ 新增車輛</button>
      </section>
    </fieldset>
    </form>
  </aside>
</div>

<nav class="workspace-switch" id="workspaceSwitch" aria-label="切換編輯或預覽">
  <button type="button" id="viewEditor" aria-pressed="true" aria-controls="editorPanel">✎ 編輯</button>
  <button type="button" id="viewPreview" aria-pressed="false" aria-controls="posterScroller">◫ 預覽海報</button>
</nav>
</div>`;
