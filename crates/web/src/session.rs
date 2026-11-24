//! 登入狀態：這個分頁目前的 Session，以 Leptos context 提供給 App 外框與每個畫面。
//!
//! - Session 存在 localStorage 的 `lm.session.v1`：取得 Session（登入、註冊或換發）時覆寫；載入時讀出，無法解析時移除並
//!   視為未登入（需求 4.3）。
//! - 到期前 60 秒以 refresh token 換發；載入、回到前景、`online` 或送出需要 access token 的請求時，離到期不到 60 秒就先
//!   換發（需求 4.5、4.13）。換發之前先讀 `lm.session.v1`：是同一個 Account、而且離到期還有 60 秒以上時直接採用，不送出
//!   換發（需求 4.7）。同一個分頁同時只有一個換發，其他請求等它的結果（需求 4.8）。
//! - 其他分頁寫入或移除 `lm.session.v1` 時，依 `storage` 事件採用同樣的登入狀態（需求 4.6）。
//! - 換發被拒絕（401）或 `lm.session.v1` 被其他分頁移除時，依需求 4.9 前往 `/login?next=…`；登出依需求 4.12；
//!   新的 Session 屬於另一個 Account 時依需求 4.14。
//!
//! 已加入的 Trip_Channel 與 Pending_Command 在同步引擎中（任務 20）；它們以 [`Auth::add_hooks`] 登記 [`SessionHooks`]，
//! 在換發成功、Session 失效與切換帳號時收到通知。前往其他網址時，`Auth` 設定 [`Auth::redirect_target`]，由 App 外框的
//! 路由依它前往（`Auth` 建立在 `<Router>` 之外）。
use std::rc::Rc;
use std::time::Duration;

use futures::future::{LocalBoxFuture, Shared};
use futures::FutureExt;
// leptos::prelude 也有名為 LocalStorage 的型別（StoredValue 的存放方式），所以瀏覽器的 localStorage 改名
use gloo_storage::{LocalStorage as BrowserStorage, Storage as _};
use leptos::ev;
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::api::{ProfileDto, SessionDto};
use web_sys::VisibilityState;

use crate::api::{self, ApiFailure};
use crate::app::{home_path, login_path, Screen, Toasts};

/// localStorage 中保存 Session 的鍵（需求 4.3）。
pub const STORAGE_KEY: &str = "lm.session.v1";
/// 離到期不到這麼久時換發（需求 4.5、4.7）。
const REFRESH_MARGIN_MS: f64 = 60_000.0;
/// 按下登出後最多等待 `POST /api/auth/logout` 這麼久（需求 4.12）。
const LOGOUT_WAIT: Duration = Duration::from_secs(5);

/// 一次換發的結果。
#[derive(Clone, Debug)]
pub enum Refresh {
    /// 已採用新的 Session（換發得到的，或另一個分頁寫入的）
    Ok,
    /// 沒有可用的 Session：換發被 401 拒絕（已依需求 4.9 處理）、這個分頁沒有 Session，或已經登出（需求 4.12）
    Rejected,
    /// 網路錯誤、429 或 5xx：Session 保留，下一次 `online`、回到前景或送出請求時再換發（需求 4.13）
    Unavailable(ApiFailure),
}

/// 同步引擎（任務 20.4）登記的通知；每個 Trip_Channel 或 `TripSync` 一組。
pub struct SessionHooks {
    /// 這個分頁改用新的 access token（換發成功、另一個分頁寫入同一個 Account 的 Session，或重新登入同一個 Account）：
    /// 以 `set_access_token()` 送給已加入的 Trip_Channel（需求 4.5、4.6），並恢復送出 Pending_Command（需求 4.10）。
    pub token_changed: Box<dyn Fn(&str)>,
    /// Session 失效（需求 4.9）或登出（需求 4.12）：離開已加入的 Trip_Channel、停止送出 Pending_Command，
    /// 但把它們留在記憶體中。
    pub session_lost: Box<dyn Fn()>,
    /// 新的 Session 屬於另一個 Account（需求 4.14）：捨棄 Pending_Command 而不送出、離開已加入的 Trip_Channel，
    /// 回傳捨棄的數量。
    pub account_changed: Box<dyn Fn() -> usize>,
    /// 目前 Pending_Command 的數量，用在需求 4.9 的訊息。
    pub pending_count: Box<dyn Fn() -> usize>,
}

/// [`Auth::add_hooks`] 回傳的識別，離開旅行頁時以 [`Auth::remove_hooks`] 移除。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookId(u64);

type RefreshFuture = Shared<LocalBoxFuture<'static, Refresh>>;

/// 只在這個分頁的執行緒中使用的狀態。
#[derive(Default)]
struct State {
    /// 進行中的換發（同一個分頁同時只有一個）
    inflight: Option<RefreshFuture>,
    /// 下一次換發的計時器
    timer: Option<TimeoutHandle>,
    /// 登出、Session 失效或切換帳號時加一；換發完成時已經不同，就不採用結果（需求 4.12）
    epoch: u64,
    /// 已按下登出，`lm.session.v1` 還沒清除
    logging_out: bool,
    /// 上一次換發因為網路錯誤、429 或 5xx 失敗（需求 4.13）
    retry_needed: bool,
    /// 這個分頁最後一個 Session 的帳號；登出與 Session 失效之後仍保留，用來判斷切換帳號（需求 4.14）
    last_user: Option<ProfileDto>,
    hooks: Vec<(u64, Rc<SessionHooks>)>,
    next_hook: u64,
}

/// 這個分頁的登入狀態。`Copy`，可以直接放進事件處理與閉包。
#[derive(Clone, Copy)]
pub struct Auth {
    session: RwSignal<Option<SessionDto>>,
    user: Memo<Option<ProfileDto>>,
    /// 要前往的網址；App 外框的路由前往之後清除
    redirect: RwSignal<Option<String>>,
    state: StoredValue<State, LocalStorage>,
    toasts: Toasts,
}

/// 現在的時間（Unix 毫秒）。
fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// 離 Session 到期還有多少毫秒；`expires_at` 是 Unix 秒。
fn remaining_ms(session: &SessionDto) -> f64 {
    session.expires_at as f64 * 1000.0 - now_ms()
}

/// 離到期不到 60 秒（包括已經過期）。
fn needs_refresh(session: &SessionDto) -> bool {
    remaining_ms(session) < REFRESH_MARGIN_MS
}

/// localStorage 的 `lm.session.v1`。
mod store {
    use super::*;

    /// 讀出 Session；不存在時是 `None`，無法解析時移除並視為沒有 Session（需求 4.3）。
    pub fn read() -> Option<SessionDto> {
        let raw = BrowserStorage::raw().get_item(STORAGE_KEY).ok().flatten()?;
        match serde_json::from_str(&raw) {
            Ok(session) => Some(session),
            Err(_) => {
                remove();
                None
            }
        }
    }

    pub fn write(session: &SessionDto) {
        // localStorage 無法寫入（例如空間已滿）時，這個分頁仍以記憶體中的 Session 繼續
        let _ = BrowserStorage::set(STORAGE_KEY, session);
    }

    pub fn remove() {
        BrowserStorage::delete(STORAGE_KEY);
    }
}

/// 目前網址的路徑（結尾多出的 `/` 去掉）與查詢字串，例如 `/alice/trips/<id>?tab=meals`。
fn current_location() -> (String, String) {
    let location = window().location();
    let path = location.pathname().unwrap_or_default();
    let path = match path.trim_end_matches('/') {
        "" => "/".to_owned(),
        path => path.to_owned(),
    };
    (path, location.search().unwrap_or_default())
}

impl Auth {
    /// 建立登入狀態並放進 context：讀出 `lm.session.v1`，並監聽 `storage`、`online` 與分頁回到前景。在 App 的最外層呼叫
    /// 一次。
    pub fn provide(toasts: Toasts) -> Self {
        let session = RwSignal::new(None::<SessionDto>);
        // 只取帳號：換發只改 token，帳號相同時 Memo 不通知，畫面不重建
        let user = Memo::new(move |_| session.with(|s| s.as_ref().map(|s| s.user.clone())));
        let auth = Self {
            session,
            user,
            redirect: RwSignal::new(None),
            state: StoredValue::new_local(State::default()),
            toasts,
        };
        provide_context(auth);
        // 離到期不到 60 秒時，adopt() 安排的計時器立即換發（需求 4.5）
        if let Some(stored) = store::read() {
            auth.adopt(stored, false);
        }
        // 監聽持續到分頁關閉
        let _ = window_event_listener(ev::storage, move |event| {
            // key 是 null 表示整個 localStorage 被清除
            if event.key().is_none_or(|key| key == STORAGE_KEY) {
                auth.on_storage();
            }
        });
        let _ = window_event_listener(ev::online, move |_| auth.wake());
        let _ = window_event_listener_untyped("visibilitychange", move |_| {
            if document().visibility_state() == VisibilityState::Visible {
                auth.wake();
            }
        });
        auth
    }

    /// 目前 Session 的帳號；沒有 Session 時是 `None`。
    pub fn user(&self) -> Memo<Option<ProfileDto>> {
        self.user
    }

    /// 保存從登入或註冊取得的 Session（需求 4.3）；屬於另一個 Account 時依需求 4.14 處理。這個分頁之前沒有 Session
    /// （或是另一個 access token）時，`token_changed` 通知已登記的同步引擎以新的 Session 恢復送出 Pending_Command
    /// （需求 4.10）。由登入與註冊頁、Invite_Page（任務 19.2）使用。
    pub fn set(&self, session: SessionDto) {
        self.adopt(session, true);
    }

    /// 登記同步引擎的通知（`TripSyncs`，任務 20.2；Trip_Channel 由任務 20.4 接上）。
    pub fn add_hooks(&self, hooks: SessionHooks) -> HookId {
        let hooks = Rc::new(hooks);
        self.state
            .try_update_value(|state| {
                let id = state.next_hook;
                state.next_hook += 1;
                state.hooks.push((id, hooks));
                HookId(id)
            })
            .unwrap_or(HookId(u64::MAX))
    }

    /// 移除 [`Auth::add_hooks`] 登記的通知。
    #[allow(dead_code)]
    pub fn remove_hooks(&self, id: HookId) {
        self.state
            .update_value(|state| state.hooks.retain(|(hook, _)| *hook != id.0));
    }

    /// 要前往的網址（Session 失效、登出或切換帳號時設定）；App 外框的路由依它前往。
    pub fn redirect_target(&self) -> Option<String> {
        self.redirect.get()
    }

    /// 要求 App 外框的路由以 `replace` 前往 `to`（例如同步引擎離開已刪除的旅行時前往 Home_Page，需求 12.13）。
    pub fn redirect_to(&self, to: String) {
        self.redirect.set(Some(to));
    }

    /// 已前往 `redirect_target()` 的網址時，由 App 外框的路由清除。
    pub fn clear_redirect(&self) {
        self.redirect.set(None);
    }

    /// 送出需要 access token 的請求之前：離到期不到 60 秒（或上一次換發失敗）時先換發，再回傳 access token；
    /// 沒有可用的 Session 時是 `None`（需求 4.5、4.13）。
    pub(crate) async fn access_token(&self) -> Option<String> {
        let session = self.session.get_untracked()?;
        let retry = self.state.with_value(|state| state.retry_needed);
        if (needs_refresh(&session) || retry) && matches!(self.refresh().await, Refresh::Rejected) {
            return None;
        }
        self.access_token_now()
    }

    /// 目前的 access token，不換發。
    pub(crate) fn access_token_now(&self) -> Option<String> {
        self.session
            .with_untracked(|session| session.as_ref().map(|s| s.access_token.clone()))
    }

    /// 以 `used` 送出的請求回應 401：還沒有換發過就換發一次；其他請求已經換發得到不同的 access token 時直接改用它，
    /// 同時回應 401 的多個請求只換發一次（需求 4.8）。
    pub(crate) async fn refresh_after_unauthorized(&self, used: &str) -> Refresh {
        match self.access_token_now() {
            None => Refresh::Rejected,
            Some(current) if current != used => Refresh::Ok,
            Some(_) => self.refresh().await,
        }
    }

    /// 換發後重試的請求仍回應 401：依需求 4.9 處理（需求 4.8）。
    pub(crate) fn reject_current(&self) {
        let refresh_token = self
            .session
            .with_untracked(|session| session.as_ref().map(|s| s.refresh_token.clone()));
        if let Some(refresh_token) = refresh_token {
            self.lose_session(Some(&refresh_token));
        }
    }

    /// 換發 Session；同一個分頁同時只有一個換發，其他呼叫等同一個結果（需求 4.8）。
    pub async fn refresh(&self) -> Refresh {
        if let Some(inflight) = self.state.with_value(|state| state.inflight.clone()) {
            return inflight.await;
        }
        let auth = *self;
        let future: RefreshFuture = async move {
            let result = auth.run_refresh().await;
            auth.state.update_value(|state| state.inflight = None);
            result
        }
        .boxed_local()
        .shared();
        self.state
            .update_value(|state| state.inflight = Some(future.clone()));
        future.await
    }

    async fn run_refresh(&self) -> Refresh {
        let epoch = self.epoch();
        if self.state.with_value(|state| state.logging_out) {
            return Refresh::Rejected;
        }
        let Some(current) = self.session.get_untracked() else {
            return Refresh::Rejected;
        };
        // 先讀 lm.session.v1：另一個分頁已換發得到同一個 Account 還有 60 秒以上的 Session 時直接採用（需求 4.7）
        let refresh_token = match store::read() {
            Some(stored) if stored.user.id == current.user.id => {
                if stored.access_token != current.access_token && !needs_refresh(&stored) {
                    self.adopt(stored, false);
                    return Refresh::Ok;
                }
                stored.refresh_token
            }
            _ => current.refresh_token,
        };
        let result = api::refresh_session(&refresh_token).await;
        // 換發進行中已經登出、Session 失效或切換帳號：不寫入 lm.session.v1，也不依需求 4.9 或 4.13 處理（需求 4.12）
        if self.epoch() != epoch || self.state.with_value(|state| state.logging_out) {
            return Refresh::Rejected;
        }
        match result {
            Ok(next) => {
                self.adopt(next, true);
                Refresh::Ok
            }
            Err(failure) if failure.is_unauthorized() => {
                // 換發期間另一個分頁已換發成功（輪替後舊的 refresh token 被拒絕）：改用它，不前往 /login（需求 4.7）
                if let Some(stored) = store::read().filter(|stored| {
                    stored.user.id == current.user.id
                        && stored.refresh_token != refresh_token
                        && remaining_ms(stored) > 0.0
                }) {
                    self.adopt(stored, false);
                    return Refresh::Ok;
                }
                self.lose_session(Some(&refresh_token));
                Refresh::Rejected
            }
            Err(failure) => {
                self.state.update_value(|state| state.retry_needed = true);
                Refresh::Unavailable(failure)
            }
        }
    }

    fn epoch(&self) -> u64 {
        self.state.with_value(|state| state.epoch)
    }

    fn hooks(&self) -> Vec<Rc<SessionHooks>> {
        self.state.with_value(|state| {
            state
                .hooks
                .iter()
                .map(|(_, hooks)| Rc::clone(hooks))
                .collect()
        })
    }

    /// 採用一個 Session（登入、註冊、換發，或另一個分頁寫入的）。`persist` 時覆寫 `lm.session.v1`（需求 4.3）。
    fn adopt(&self, next: SessionDto, persist: bool) {
        let previous = self.state.with_value(|state| state.last_user.clone());
        if let Some(previous) = previous.filter(|previous| previous.id != next.user.id) {
            self.switch_account(&previous, &next.user);
        }
        let token_changed = self.access_token_now().as_deref() != Some(next.access_token.as_str());
        self.state.update_value(|state| {
            if state.logging_out {
                // 登出等待期間採用另一個分頁寫入的 Session：不再清除它
                state.logging_out = false;
                state.epoch += 1;
            }
            state.retry_needed = false;
            state.last_user = Some(next.user.clone());
        });
        if persist {
            store::write(&next);
        }
        self.schedule(&next);
        let token = next.access_token.clone();
        self.session.set(Some(next));
        if token_changed {
            for hooks in self.hooks() {
                (hooks.token_changed)(&token);
            }
        }
    }

    /// 依 Session 的到期時間安排下一次換發：到期前 60 秒，已經不到 60 秒時立即換發（需求 4.5）。
    fn schedule(&self, session: &SessionDto) {
        self.cancel_timer();
        let delay = (remaining_ms(session) - REFRESH_MARGIN_MS).clamp(0.0, f64::from(i32::MAX));
        let auth = *self;
        let handle = set_timeout_with_handle(
            move || {
                auth.state.update_value(|state| state.timer = None);
                spawn_local(async move {
                    auth.refresh().await;
                });
            },
            Duration::from_millis(delay as u64),
        )
        .ok();
        self.state.update_value(|state| state.timer = handle);
    }

    fn cancel_timer(&self) {
        if let Some(timer) = self
            .state
            .try_update_value(|state| state.timer.take())
            .flatten()
        {
            timer.clear();
        }
    }

    /// `online` 或分頁回到前景：離到期不到 60 秒，或上一次換發失敗時再換發（需求 4.5、4.13）。
    fn wake(&self) {
        let Some(session) = self.session.get_untracked() else {
            return;
        };
        if needs_refresh(&session) || self.state.with_value(|state| state.retry_needed) {
            let auth = *self;
            spawn_local(async move {
                auth.refresh().await;
            });
        }
    }

    /// 另一個分頁寫入或移除了 `lm.session.v1`（需求 4.6）。
    fn on_storage(&self) {
        match store::read() {
            Some(stored) => {
                let same = self
                    .session
                    .with_untracked(|session| session.as_ref() == Some(&stored));
                if !same {
                    // 同一個 Account：改用新的 access token 並重新安排換發；另一個 Account：依需求 4.14。
                    // 這個分頁停在 /login 時，路由依需求 4.10 前往下一個畫面
                    self.adopt(stored, false);
                }
            }
            None if self.state.with_value(|state| state.logging_out) => {
                let epoch = self.epoch();
                self.finish_logout(epoch);
            }
            None => {
                if self.session.with_untracked(Option::is_some) {
                    self.lose_session(None);
                }
            }
        }
    }

    /// Session 失效（需求 4.9）：離開 Trip_Channel、停止送出 Pending_Command（留在記憶體中）、`lm.session.v1` 仍是
    /// 被拒絕的 Session（以 refresh token 判斷）時移除它，並前往 `/login?next=<目前的路徑>`。
    fn lose_session(&self, rejected_refresh_token: Option<&str>) {
        self.cancel_timer();
        self.state.update_value(|state| {
            state.epoch += 1;
            state.retry_needed = false;
            state.logging_out = false;
        });
        if let Some(rejected) = rejected_refresh_token {
            if store::read().is_some_and(|stored| stored.refresh_token == rejected) {
                store::remove();
            }
        }
        let hooks = self.hooks();
        for hooks in &hooks {
            (hooks.session_lost)();
        }
        let pending: usize = hooks.iter().map(|hooks| (hooks.pending_count)()).sum();
        let (path, search) = current_location();
        let target = match Screen::parse(&path) {
            Screen::Login | Screen::Register => "/login".to_owned(),
            _ => login_path(&format!("{path}{search}")),
        };
        self.redirect.set(Some(target));
        self.session.set(None);
        self.toasts.show(if pending > 0 {
            format!("登入已失效，請重新登入；尚有 {pending} 項變更未送出")
        } else {
            "登入已失效，請重新登入".to_owned()
        });
    }

    /// 新的 Session 屬於另一個 Account（需求 4.14）：捨棄原 Account 的 Pending_Command、離開 Trip_Channel，停在原
    /// Account 的 Home_Page、Trip_Page 或 Departure_Page 時前往新 Account 的 Home_Page。
    fn switch_account(&self, previous: &ProfileDto, next: &ProfileDto) {
        // 原 Account 進行中的換發不再採用
        self.state.update_value(|state| state.epoch += 1);
        let discarded: usize = self
            .hooks()
            .iter()
            .map(|hooks| (hooks.account_changed)())
            .sum();
        let (path, _) = current_location();
        if let Screen::Home { owner }
        | Screen::Trip { owner, .. }
        | Screen::Departure { owner, .. } = Screen::parse(&path)
        {
            if owner == previous.username {
                self.redirect.set(Some(home_path(&next.username)));
            }
        }
        if discarded > 0 {
            self.toasts
                .show(format!("有 {discarded} 項變更因為切換帳號而沒有儲存。"));
        }
    }

    /// 登出（需求 4.12）：以目前的 access token 送出 `POST /api/auth/logout`；請求完成（不論狀態碼）、失敗或 5 秒後仍未
    /// 完成時，清除 `lm.session.v1`、離開 Trip_Channel 並前往 `/login`，不顯示需求 4.9 的訊息。
    pub fn logout(&self) {
        let Some(token) = self.access_token_now() else {
            return;
        };
        if self.state.with_value(|state| state.logging_out) {
            return;
        }
        self.cancel_timer();
        let epoch = self
            .state
            .try_update_value(|state| {
                state.logging_out = true;
                // 進行中的換發完成時不再寫入 lm.session.v1
                state.epoch += 1;
                state.epoch
            })
            .unwrap_or_default();
        let auth = *self;
        spawn_local(async move {
            let _ = api::logout_request(&token).await;
            auth.finish_logout(epoch);
        });
        set_timeout(move || auth.finish_logout(epoch), LOGOUT_WAIT);
    }

    /// 登出的請求結束或等待逾時；只執行一次。
    fn finish_logout(&self, epoch: u64) {
        let finish = self
            .state
            .try_update_value(|state| {
                let finish = state.logging_out && state.epoch == epoch;
                if finish {
                    state.logging_out = false;
                }
                finish
            })
            .unwrap_or(false);
        if !finish {
            return;
        }
        store::remove();
        for hooks in self.hooks() {
            (hooks.session_lost)();
        }
        self.redirect.set(Some("/login".to_owned()));
        self.session.set(None);
    }
}

/// 取得 App 最外層提供的登入狀態。
pub fn use_auth() -> Auth {
    expect_context::<Auth>()
}
