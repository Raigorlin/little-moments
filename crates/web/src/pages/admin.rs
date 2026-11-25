//! Admin_Page（`/admin`，需求 34 至 41，design 5.6）：統計列、公開註冊的開關、帳號列表（搜尋、編輯帳號、重設密碼、
//! 停用與啟用）與操作紀錄。
//!
//! - 結構與 class 依 design 5.6（沿用 `src/accounts-ui.js` 的 `renderAdmin()` 的 class 名稱，使 `accounts.css` 的
//!   `.acct-admin>section`、`.acct-stats`、`.acct-user-row.is-deleted`、`.acct-audit` 直接適用）；現行樣式沒有的
//!   搜尋欄、開關與換頁列的規則在 `styles/admin.css`（需求 34.9、32.8）。
//! - 公開註冊、帳號列表與操作紀錄是三個獨立的區塊，各自以 `RwSignal<Block<_>>`、讀取次數與 `spawn_local` 讀取
//!   （與 Home_Page 相同），失敗只影響自己的區塊；統計列由帳號列表計算（需求 34.7、35.6）。重新讀取時只採用最後一次
//!   請求的結果，已顯示的內容保留到新的結果到達，所以搜尋文字、篩選結果與按鈕的焦點都不變（需求 35.5）。
//! - 每次寫入成功後重新讀取帳號列表與操作紀錄第 1 頁（需求 34.8）；不加入任何 Trip_Channel。
//! - 任何回應 403 `admin_required` 時整頁改為需求 34.5 的訊息頁；401 已由登入狀態依需求 4.8、4.9 處理。
//! - 對話框沿用 `views/trip_menu.rs` 的刪除旅行對話框（`<dialog>` 與 `showModal()`）：第一個欄位或按鈕有
//!   `autofocus`，Esc 關閉（送出期間不關閉），關閉後瀏覽器把焦點還給開啟它的按鈕。對話框的內容只在開啟時建立，
//!   所以新密碼只存在對話框元件的 signal 中，關閉時隨元件捨棄（需求 36.7）。
//! - 頁面上的開關、「啟用帳號」與換頁按鈕在送出或讀取期間以 `aria-disabled` 停用並忽略點選，不設定 `disabled`：
//!   瀏覽器會讓取得焦點的元素在設為 `disabled` 時失去焦點，鍵盤使用者就要從頁首重新找起（需求 34.9）。
//!
//! 伺服器回傳的文字（帳號名稱、顯示名稱、操作紀錄的目標與補充說明）一律以文字節點或屬性輸出；只有介面圖示以
//! `art::static_svg()` 放進畫面（需求 32.6）。
use leptos::ev::{self, MouseEvent, SubmitEvent};
use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::account::{check_display_name, check_password, PASSWORD_MISMATCH};
use lm_core::admin::{
    account_matches, admin_stats, audit_action_label, taipei_minute, AdminStats, AdminUserDto,
    AdminUsersResponse, AuditEntryDto, AuditPage, Policy, PublicSignupSetting,
    ResetPasswordRequest, SettingSource, UpdateUserRequest, PASSWORD_RESET_AUDIT_FAILED,
};
use lm_core::ids::UserId;
use lm_core::model::Role;
use lm_core::presence::avatar_initial;

use crate::api::{use_api, ApiFailure};
use crate::app::{use_toasts, HomeLink, MessagePage, Shell, ADMIN_ONLY, FORBIDDEN_TITLE};
use crate::art;
use crate::session::use_auth;
use crate::views::icons;

/// 文件標題（需求 34.6）。
const TITLE: &str = "管理後台 · 日子拾光";
/// 不是 Admin 時 Admin_Endpoint 的錯誤代碼（需求 34.1）。
const ADMIN_REQUIRED: &str = "admin_required";
/// 頁碼不存在時操作紀錄的錯誤代碼（需求 41.4）。
const INVALID_PAGE: &str = "invalid_page";
/// 每個區塊讀取期間的文字（需求 34.7）。
const LOADING: &str = "載入中…";
/// 編輯帳號時沒有任何變更（需求 39.2）。
const NO_CHANGES: &str = "沒有變更的內容。";
/// 失敗訊息的開頭：編輯帳號與公開註冊（需求 37.7、39.7）、重設密碼（需求 36.8）、停用與啟用（需求 40.7）。
const NOT_SAVED: &str = "尚未儲存";
const NOT_SET: &str = "尚未設定";
const NOT_DONE: &str = "尚未完成";
/// 公開註冊開關旁的狀態（需求 37.6）。
const SIGNUP_OPEN: &str = "開放：任何人都能在註冊頁建立帳號。";
const SIGNUP_CLOSED: &str = "關閉：只能以旅行的邀請連結建立帳號。";
/// 操作紀錄的執行者已不存在時（需求 41.5）。
const DELETED_ACCOUNT: &str = "已刪除的帳號";

/// 一個區塊的讀取狀態。
#[derive(Clone, Debug, PartialEq)]
enum Block<T> {
    Loading,
    Ready(T),
    Failed(String),
}

/// [`Block`] 不含資料的部分：區塊只在它改變時重建，資料改變時只更新文字與屬性（保留焦點）。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Loading,
    Ready,
    Failed(String),
}

impl<T> Block<T> {
    fn phase(&self) -> Phase {
        match self {
            Block::Loading => Phase::Loading,
            Block::Ready(_) => Phase::Ready,
            Block::Failed(message) => Phase::Failed(message.clone()),
        }
    }

    fn ready(&self) -> Option<&T> {
        match self {
            Block::Ready(value) => Some(value),
            _ => None,
        }
    }
}

/// 讀取或寫入失敗：回應 403 `admin_required` 時整頁改為訊息頁（需求 34.5），401 已由登入狀態處理（需求 4.9），
/// 兩者都回傳 `None`；其他失敗原樣回傳，由呼叫端顯示在自己的區塊或對話框中。
fn unhandled(failure: ApiFailure, denied: RwSignal<bool>) -> Option<ApiFailure> {
    if failure.code == ADMIN_REQUIRED {
        denied.try_set(true);
        return None;
    }
    if failure.is_unauthorized() {
        return None;
    }
    Some(failure)
}

/// 寫入失敗的訊息：「{開頭}：{message}」，網路錯誤或逾時時為「{開頭}，請檢查網路後再試一次。」（需求 36.8、37.7、
/// 39.7、40.7）。
fn failure_text(prefix: &str, failure: &ApiFailure) -> String {
    if failure.is_network() {
        format!("{prefix}，請檢查網路後再試一次。")
    } else {
        format!("{prefix}：{}", failure.message)
    }
}

/// 重設密碼完成時的 Toast（需求 36.8）；LM_Server 回應 `password_reset_audit_failed` 時重設已經生效，另外說明
/// 這次操作沒有寫入操作紀錄（需求 36.10）。
fn password_set_toast(display_name: &str, logged: bool) -> String {
    if logged {
        format!("已為 {display_name} 設定新密碼")
    } else {
        format!("已為 {display_name} 設定新密碼，但這次操作沒有寫入操作紀錄")
    }
}

const fn role_label(role: Role) -> &'static str {
    match role {
        Role::Admin => "管理員",
        Role::Member => "成員",
    }
}

/// 帳號列的第二行：「@帳號名稱 · 管理員 · 使用中 · 3 趟旅行」（需求 35.2）。
fn user_summary(user: &AdminUserDto) -> String {
    format!(
        "@{} · {} · {} · {} 趟旅行",
        user.username,
        role_label(user.role),
        if user.is_disabled() {
            "已停用"
        } else {
            "使用中"
        },
        user.trip_count
    )
}

/// 公開註冊的來源說明（需求 37.6）。
fn source_help(setting: &PublicSignupSetting) -> String {
    match setting.source {
        SettingSource::Default => "目前使用預設值（開放）。".to_owned(),
        SettingSource::Seed => "目前使用伺服器環境變數 LM_PUBLIC_SIGNUP 的初始值。".to_owned(),
        SettingSource::Stored => {
            let by = setting
                .updated_by
                .as_ref()
                .map_or(DELETED_ACCOUNT, |actor| actor.display_name.as_str());
            let at = setting
                .updated_at
                .as_deref()
                .map(|at| taipei_minute(at).unwrap_or_else(|| at.to_owned()))
                .unwrap_or_default();
            format!("由 {by} 於 {at} 設定；伺服器環境變數 LM_PUBLIC_SIGNUP 不再生效。")
        }
    }
}

/// 以寫入的回應取代列表中的同一個帳號，使這一列在重新讀取之前就顯示新的狀態。
fn replace_user(users: RwSignal<Block<AdminUsersResponse>>, updated: &AdminUserDto) {
    users.try_update(|block| {
        if let Block::Ready(response) = block {
            if let Some(slot) = response.users.iter_mut().find(|user| user.id == updated.id) {
                *slot = updated.clone();
            }
        }
    });
}

/// Admin_Page（App 外框已確認 Session 的角色是 admin）。Admin_Endpoint 回應 403 `admin_required` 時改為訊息頁。
#[component]
pub fn AdminPage() -> impl IntoView {
    let denied = RwSignal::new(false);
    move || {
        if denied.get() {
            view! {
                <MessagePage title=FORBIDDEN_TITLE body=ADMIN_ONLY>
                    <HomeLink />
                </MessagePage>
            }
            .into_any()
        } else {
            view! { <AdminContent denied /> }.into_any()
        }
    }
}

/// 讀取期間的文字。
#[component]
fn Loading() -> impl IntoView {
    view! {
        <p class="acct-loading" role="status">
            {LOADING}
        </p>
    }
}

/// 讀取失敗：失敗原因與「重新載入」（需求 34.7）。
#[component]
fn Failed(message: String, on_retry: Callback<()>) -> impl IntoView {
    view! {
        <div class="acct-error" role="alert">
            <p>{message}</p>
            <div class="acct-actions">
                <button type="button" class="button small" on:click=move |_| on_retry.run(())>
                    "重新載入"
                </button>
            </div>
        </div>
    }
}

#[component]
fn AdminContent(denied: RwSignal<bool>) -> impl IntoView {
    let api = use_api();
    let auth = use_auth();
    let toasts = use_toasts();
    document().set_title(TITLE);
    let me = Memo::new(move |_| auth.user().with(|user| user.as_ref().map(|user| user.id)));

    // ── 帳號列表（需求 35.1–35.5） ──
    let users = RwSignal::new(Block::<AdminUsersResponse>::Loading);
    let user_loads = StoredValue::new(0_u64);
    let load_users = move || {
        let id = user_loads.get_value() + 1;
        user_loads.set_value(id);
        spawn_local(async move {
            let result = api.admin_users().await;
            if user_loads.try_get_value() != Some(id) {
                return;
            }
            match result {
                Ok(list) => users.set(Block::Ready(list)),
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        users.set(Block::Failed(failure.message));
                    }
                }
            }
        });
    };

    // ── 公開註冊（需求 37.6、37.7） ──
    let settings = RwSignal::new(Block::<PublicSignupSetting>::Loading);
    // 開關目前的狀態：切換時先改變（樂觀更新），失敗時恢復
    let signup_on = RwSignal::new(false);
    let signup_busy = RwSignal::new(false);
    let signup_error = RwSignal::new(None::<String>);
    let setting_loads = StoredValue::new(0_u64);
    let load_settings = move || {
        let id = setting_loads.get_value() + 1;
        setting_loads.set_value(id);
        spawn_local(async move {
            let result = api.admin_settings().await;
            if setting_loads.try_get_value() != Some(id) {
                return;
            }
            match result {
                Ok(response) => {
                    signup_on.set(response.public_signup.value == Policy::Open);
                    settings.set(Block::Ready(response.public_signup));
                }
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        settings.set(Block::Failed(failure.message));
                    }
                }
            }
        });
    };

    // ── 操作紀錄（需求 41.5、41.6） ──
    let audit = RwSignal::new(Block::<AuditPage>::Loading);
    let audit_loads = StoredValue::new(0_u64);
    let audit_busy = RwSignal::new(false);
    // 「重新載入」讀取的頁碼：頁碼已不存在（invalid_page）時回到第 1 頁
    let audit_retry = StoredValue::new(1_u32);
    let load_audit = move |page: u32| {
        let id = audit_loads.get_value() + 1;
        audit_loads.set_value(id);
        audit_busy.set(true);
        spawn_local(async move {
            let result = api.admin_audit(page).await;
            if audit_loads.try_get_value() != Some(id) {
                return;
            }
            audit_busy.set(false);
            match result {
                Ok(entries) => audit.set(Block::Ready(entries)),
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        audit_retry.set_value(if failure.code == INVALID_PAGE {
                            1
                        } else {
                            page
                        });
                        audit.set(Block::Failed(failure.message));
                    }
                }
            }
        });
    };

    load_settings();
    load_users();
    load_audit(1);
    // 這個分頁的寫入成功之後（需求 34.8）
    let after_write = move || {
        load_users();
        load_audit(1);
    };

    // ── 統計列（需求 35.6） ──
    let users_phase = Memo::new(move |_| users.with(Block::phase));
    let stats = Memo::new(move |_| users.with(|block| block.ready().map(admin_stats)));
    let stat = move |pick: fn(&AdminStats) -> u32| {
        move || stats.get().map(|stats| pick(&stats)).unwrap_or_default()
    };
    let stats_view = move || match users_phase.get() {
        // 帳號列表讀取失敗時不顯示統計列（需求 34.7）
        Phase::Failed(_) => None,
        Phase::Loading => Some(
            view! {
                <section id="admin-stats" aria-label="統計">
                    <Loading />
                </section>
            }
            .into_any(),
        ),
        Phase::Ready => Some(
            view! {
                <section id="admin-stats" aria-label="統計">
                    <dl class="acct-stats">
                        <div>
                            <dt>"帳號總數"</dt>
                            <dd>{stat(|s| s.accounts)}</dd>
                        </div>
                        <div>
                            <dt>"使用中"</dt>
                            <dd>{stat(|s| s.active)}</dd>
                        </div>
                        <div>
                            <dt>"已停用"</dt>
                            <dd>{stat(|s| s.disabled)}</dd>
                        </div>
                        <div>
                            <dt>"管理員"</dt>
                            <dd>{stat(|s| s.admins)}</dd>
                        </div>
                        <div>
                            <dt>"旅行總數"</dt>
                            <dd>{stat(|s| s.trips)}</dd>
                        </div>
                    </dl>
                </section>
            }
            .into_any(),
        ),
    };

    // ── 公開註冊的開關 ──
    let toggle_signup = move |event: ev::Event| {
        if signup_busy.get_untracked() {
            return;
        }
        let previous = signup_on.get_untracked();
        let next = event_target_checked(&event);
        signup_on.set(next);
        signup_error.set(None);
        signup_busy.set(true);
        let policy = if next { Policy::Open } else { Policy::Closed };
        spawn_local(async move {
            let result = api.set_public_signup(policy).await;
            signup_busy.try_set(false);
            match result {
                Ok(response) => {
                    let open = response.public_signup.value == Policy::Open;
                    signup_on.try_set(open);
                    settings.try_set(Block::Ready(response.public_signup));
                    toasts.show(if open {
                        "已開放公開註冊"
                    } else {
                        "已關閉公開註冊"
                    });
                    after_write();
                }
                Err(failure) => {
                    signup_on.try_set(previous);
                    if let Some(failure) = unhandled(failure, denied) {
                        signup_error.try_set(Some(failure_text(NOT_SAVED, &failure)));
                    }
                }
            }
        });
    };
    let settings_phase = Memo::new(move |_| settings.with(Block::phase));
    let retry_settings = Callback::new(move |()| {
        settings.set(Block::Loading);
        load_settings();
    });
    let settings_view = move || match settings_phase.get() {
        Phase::Loading => view! { <Loading /> }.into_any(),
        Phase::Failed(message) => view! { <Failed message on_retry=retry_settings /> }.into_any(),
        Phase::Ready => view! {
            <div class="admin-switch-row">
                <input
                    type="checkbox"
                    role="switch"
                    id="admin-public-signup"
                    class="admin-switch"
                    prop:checked=move || signup_on.get()
                    // 送出期間停用（需求 37.7）：以 aria-disabled 並擋下點選，不用 disabled，使鍵盤的焦點留在開關上
                    aria-disabled=move || signup_busy.get().then_some("true")
                    aria-describedby="admin-public-signup-help"
                    on:click=move |event: MouseEvent| {
                        if signup_busy.get_untracked() {
                            event.prevent_default();
                        }
                    }
                    on:change=toggle_signup
                />
                <label for="admin-public-signup">"開放公開註冊"</label>
                <p class="admin-switch-state" aria-live="polite">
                    {move || if signup_on.get() { SIGNUP_OPEN } else { SIGNUP_CLOSED }}
                </p>
            </div>
            <p class="help" id="admin-public-signup-help">
                {move || settings.with(|block| block.ready().map(source_help).unwrap_or_default())}
            </p>
            <p class="form-error" role="alert">
                {move || signup_error.get()}
            </p>
        }
        .into_any(),
    };

    // ── 帳號列表 ──
    let query = RwSignal::new(String::new());
    let visible = Memo::new(move |_| {
        users.with(|block| {
            block
                .ready()
                .map(|response| {
                    query.with(|query| {
                        response
                            .users
                            .iter()
                            .filter(|user| {
                                account_matches(query, &user.username, &user.display_name)
                            })
                            .map(|user| user.id)
                            .collect::<Vec<_>>()
                    })
                })
                .unwrap_or_default()
        })
    });
    let total = Memo::new(move |_| {
        users.with(|block| block.ready().map_or(0, |response| response.users.len()))
    });
    let users_error = RwSignal::new(None::<String>);
    let edit_target = RwSignal::new(None::<AdminUserDto>);
    let reset_target = RwSignal::new(None::<AdminUserDto>);
    let disable_target = RwSignal::new(None::<AdminUserDto>);
    let enabling = RwSignal::new(None::<UserId>);
    let open_edit = Callback::new(move |user: AdminUserDto| {
        users_error.set(None);
        edit_target.set(Some(user));
    });
    let open_reset = Callback::new(move |user: AdminUserDto| {
        users_error.set(None);
        reset_target.set(Some(user));
    });
    let open_disable = Callback::new(move |user: AdminUserDto| {
        users_error.set(None);
        disable_target.set(Some(user));
    });
    // 啟用沒有對話框（可以復原，需求 40.6、40.7）
    let enable = Callback::new(move |target: AdminUserDto| {
        if enabling.get_untracked().is_some() {
            return;
        }
        users_error.set(None);
        enabling.set(Some(target.id));
        spawn_local(async move {
            let result = api.enable_user(target.id).await;
            enabling.try_set(None);
            match result {
                Ok(updated) => {
                    replace_user(users, &updated);
                    toasts.show(format!("已啟用 {}", updated.display_name));
                    after_write();
                }
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        users_error.try_set(Some(failure_text(NOT_DONE, &failure)));
                    }
                }
            }
        });
    });
    let retry_users = Callback::new(move |()| {
        users.set(Block::Loading);
        load_users();
    });
    let users_view = move || match users_phase.get() {
        Phase::Loading => view! { <Loading /> }.into_any(),
        Phase::Failed(message) => view! { <Failed message on_retry=retry_users /> }.into_any(),
        Phase::Ready => view! {
            <p class="help" role="status">
                {move || format!("符合 {} 個帳號，共 {} 個", visible.with(Vec::len), total.get())}
            </p>
            <p class="form-error" role="alert">
                {move || users_error.get()}
            </p>
            {move || {
                if total.get() == 0 {
                    Some(view! { <p class="empty">"還沒有任何帳號。"</p> })
                } else if visible.with(Vec::is_empty) {
                    Some(view! { <p class="empty">"找不到符合的帳號。"</p> })
                } else {
                    None
                }
            }}
            <ul class="acct-user-list">
                <For each=move || visible.get() key=|id| *id let:id>
                    <UserRow
                        id
                        users
                        me
                        enabling
                        on_edit=open_edit
                        on_reset=open_reset
                        on_disable=open_disable
                        on_enable=enable
                    />
                </For>
            </ul>
        }
        .into_any(),
    };

    // ── 操作紀錄 ──
    let audit_phase = Memo::new(move |_| audit.with(Block::phase));
    let page = move || audit.with(|block| block.ready().map_or(1, |page| page.page));
    let page_count = move || audit.with(|block| block.ready().map_or(1, |page| page.page_count));
    let is_first_page = move || page() <= 1;
    let is_last_page = move || page() >= page_count();
    let retry_audit = Callback::new(move |()| {
        audit.set(Block::Loading);
        load_audit(audit_retry.get_value());
    });
    let audit_view = move || {
        match audit_phase.get() {
        Phase::Loading => view! { <Loading /> }.into_any(),
        Phase::Failed(message) => view! { <Failed message on_retry=retry_audit /> }.into_any(),
        Phase::Ready => view! {
            {move || {
                audit.with(|block| {
                    let entries = block.ready().map(|page| page.entries.as_slice()).unwrap_or_default();
                    if entries.is_empty() {
                        view! { <p class="empty">"目前還沒有操作紀錄。"</p> }.into_any()
                    } else {
                        let rows = entries.iter().map(audit_row).collect_view();
                        view! { <ol class="acct-audit">{rows}</ol> }.into_any()
                    }
                })
            }}
            <nav class="admin-pager" aria-label="操作紀錄的頁碼">
                // 讀取期間以 aria-disabled 停用兩個按鈕（需求 41.6），使按下的按鈕保留焦點
                <button
                    type="button"
                    class="button small"
                    disabled=is_first_page
                    aria-disabled=move || audit_busy.get().then_some("true")
                    on:click=move |_: MouseEvent| {
                        if !audit_busy.get_untracked() {
                            load_audit(page() - 1);
                        }
                    }
                >
                    "上一頁"
                </button>
                <span>{move || format!("第 {} / {} 頁", page(), page_count())}</span>
                <button
                    type="button"
                    class="button small"
                    disabled=is_last_page
                    aria-disabled=move || audit_busy.get().then_some("true")
                    on:click=move |_: MouseEvent| {
                        if !audit_busy.get_untracked() {
                            load_audit(page() + 1);
                        }
                    }
                >
                    "下一頁"
                </button>
            </nav>
            <p class="help">"只顯示最新的 200 筆。"</p>
        }
        .into_any(),
    }
    };

    // ── 對話框完成之後 ──
    let close_edit = Callback::new(move |()| edit_target.set(None));
    let close_reset = Callback::new(move |()| reset_target.set(None));
    let close_disable = Callback::new(move |()| disable_target.set(None));
    let edited = Callback::new(move |updated: AdminUserDto| {
        edit_target.set(None);
        replace_user(users, &updated);
        toasts.show(format!("已更新 {} 的帳號", updated.display_name));
        after_write();
        // 自己的顯示名稱：以 GET /api/me 更新 Session 與頁首（需求 39.6）
        if me.get_untracked() == Some(updated.id) {
            spawn_local(async move {
                if let Ok(profile) = api.me().await {
                    auth.update_profile(profile);
                }
            });
        }
    });
    let password_set = Callback::new(move |(target, logged): (AdminUserDto, bool)| {
        reset_target.set(None);
        toasts.show(password_set_toast(&target.display_name, logged));
        after_write();
    });
    let disabled = Callback::new(move |updated: AdminUserDto| {
        disable_target.set(None);
        replace_user(users, &updated);
        toasts.show(format!("已停用 {}", updated.display_name));
        after_write();
    });
    let edit_busy = RwSignal::new(false);
    let reset_busy = RwSignal::new(false);
    let disable_busy = RwSignal::new(false);

    view! {
        <Shell current="admin">
            <div class="acct-admin">
                <header class="acct-admin-head">
                    <span class="eyebrow">"ADMIN"</span>
                    <h1>"管理後台"</h1>
                    <p class="help">"查詢與管理帳號、協助重設密碼，並設定是否開放公開註冊。"</p>
                </header>
                {stats_view}
                <section aria-labelledby="admin-signup-title">
                    <h2 id="admin-signup-title">"公開註冊"</h2>
                    {settings_view}
                </section>
                <section aria-labelledby="admin-users-title">
                    <h2 id="admin-users-title">"帳號"</h2>
                    <div class="field admin-search">
                        <label for="admin-user-search">"搜尋帳號"</label>
                        <input
                            id="admin-user-search"
                            type="search"
                            placeholder="輸入帳號名稱或顯示名稱"
                            autocomplete="off"
                            prop:value=move || query.get()
                            on:input=move |event| query.set(event_target_value(&event))
                        />
                    </div>
                    {users_view}
                </section>
                <section aria-labelledby="admin-audit-title">
                    <h2 id="admin-audit-title">"操作紀錄"</h2>
                    {audit_view}
                </section>
            </div>
        </Shell>
        <AdminDialog
            open=Signal::derive(move || edit_target.with(Option::is_some))
            busy=edit_busy
            labelled_by="admin-edit-title"
            title="編輯帳號"
            on_close=close_edit
        >
            {move || {
                edit_target
                    .get()
                    .map(|user| {
                        let is_self = me.get_untracked() == Some(user.id);
                        view! {
                            <EditUserForm
                                user
                                is_self
                                busy=edit_busy
                                denied
                                on_cancel=close_edit
                                on_saved=edited
                            />
                        }
                    })
            }}
        </AdminDialog>
        <AdminDialog
            open=Signal::derive(move || reset_target.with(Option::is_some))
            busy=reset_busy
            labelled_by="admin-reset-title"
            title="重設密碼"
            on_close=close_reset
        >
            {move || {
                reset_target
                    .get()
                    .map(|user| {
                        let is_self = me.get_untracked() == Some(user.id);
                        view! {
                            <ResetPasswordForm
                                user
                                is_self
                                busy=reset_busy
                                denied
                                on_cancel=close_reset
                                on_done=password_set
                            />
                        }
                    })
            }}
        </AdminDialog>
        <AdminDialog
            open=Signal::derive(move || disable_target.with(Option::is_some))
            busy=disable_busy
            labelled_by="admin-disable-title"
            title="停用帳號"
            on_close=close_disable
        >
            {move || {
                disable_target
                    .get()
                    .map(|user| {
                        view! {
                            <DisableUserForm
                                user
                                busy=disable_busy
                                denied
                                on_cancel=close_disable
                                on_done=disabled
                            />
                        }
                    })
            }}
        </AdminDialog>
    }
}

/// 帳號列表的一列（需求 35.2）。以帳號 id 為鍵，資料改變時只更新文字與屬性，按鈕保留焦點。
#[component]
fn UserRow(
    id: UserId,
    users: RwSignal<Block<AdminUsersResponse>>,
    me: Memo<Option<UserId>>,
    /// 正在啟用的帳號
    enabling: RwSignal<Option<UserId>>,
    on_edit: Callback<AdminUserDto>,
    on_reset: Callback<AdminUserDto>,
    on_disable: Callback<AdminUserDto>,
    on_enable: Callback<AdminUserDto>,
) -> impl IntoView {
    let user = Memo::new(move |_| {
        users.with(|block| {
            block
                .ready()
                .and_then(|response| response.users.iter().find(|user| user.id == id).cloned())
        })
    });
    let read = move |f: fn(&AdminUserDto) -> String| {
        user.with(|user| user.as_ref().map(f).unwrap_or_default())
    };
    let is_disabled =
        move || user.with(|user| user.as_ref().is_some_and(AdminUserDto::is_disabled));
    let is_self = move || me.get() == Some(id);
    let avatar = move || {
        let admin = user.with(|user| user.as_ref().is_some_and(|user| user.role == Role::Admin));
        if admin {
            "avatar small yellow"
        } else {
            "avatar small blue"
        }
    };
    let with_user = move |callback: Callback<AdminUserDto>| {
        move |_: MouseEvent| {
            if let Some(user) = user.get_untracked() {
                callback.run(user);
            }
        }
    };
    let toggle = move |_: MouseEvent| {
        let Some(user) = user.get_untracked() else {
            return;
        };
        if user.is_disabled() {
            on_enable.run(user);
        } else {
            on_disable.run(user);
        }
    };
    view! {
        <li class="acct-user-row" class:is-deleted=is_disabled>
            <div class="acct-user-info">
                <span class=avatar aria-hidden="true">
                    {move || read(|user| avatar_initial(&user.display_name).as_str().to_owned())}
                </span>
                <div>
                    <b>{move || read(|user| user.display_name.clone())}</b>
                    {move || {
                        is_self()
                            .then(|| {
                                view! {
                                    " "
                                    <span class="acct-pill">"你"</span>
                                }
                            })
                    }}
                    <small>{move || read(user_summary)}</small>
                </div>
            </div>
            <div class="acct-actions">
                <button type="button" class="button small" on:click=with_user(on_edit)>
                    "編輯帳號"
                </button>
                <button type="button" class="button small" on:click=with_user(on_reset)>
                    "重設密碼"
                </button>
                <button
                    type="button"
                    class="button small"
                    class:danger=move || !is_disabled()
                    disabled=is_self
                    // 啟用期間以 aria-disabled 停用（on_enable 不接受第二次），不用 disabled：瀏覽器會讓停用的按鈕失去焦點
                    aria-disabled=move || (enabling.get() == Some(id)).then_some("true")
                    on:click=toggle
                >
                    {move || match (is_disabled(), enabling.get() == Some(id)) {
                        (true, true) => "啟用中…",
                        (true, false) => "啟用帳號",
                        (false, _) => "停用帳號",
                    }}
                </button>
            </div>
            {move || {
                is_self()
                    .then(|| {
                        view! {
                            <small class="help acct-row-note">
                                "不能停用自己的帳號，也不能變更自己的角色。"
                            </small>
                        }
                    })
            }}
        </li>
    }
}

/// 操作紀錄的一筆（需求 41.5）：台灣時間、「{執行者}（@帳號名稱） · {操作} · {目標}」與補充說明。
fn audit_row(entry: &AuditEntryDto) -> impl IntoView {
    let shown = taipei_minute(&entry.at).unwrap_or_else(|| entry.at.clone());
    let actor = match &entry.actor {
        Some(actor) => view! {
            <b>{actor.display_name.clone()}</b>
            {format!("（@{}）", actor.username)}
        }
        .into_any(),
        None => view! { <b>{DELETED_ACCOUNT}</b> }.into_any(),
    };
    let action =
        audit_action_label(&entry.action).map_or_else(|| entry.action.clone(), str::to_owned);
    let detail = (!entry.detail.is_empty()).then(|| format!(" · {}", entry.detail));
    view! {
        <li>
            <time datetime=entry.at.clone()>{shown}</time>
            <span>
                {actor}
                {format!(" · {action} · ")}
                <span class="acct-audit-target">{entry.target.clone()}</span>
                {detail}
            </span>
        </li>
    }
}

/// 對話框的外框（沿用刪除旅行的確認對話框）：標題列與關閉按鈕、`dialog-content`。`open` 時以 `showModal()` 開啟，
/// 內容只在開啟時建立；送出期間（`busy`）Esc 與關閉按鈕都不關閉。
#[component]
fn AdminDialog(
    #[prop(into)] open: Signal<bool>,
    busy: RwSignal<bool>,
    labelled_by: &'static str,
    title: &'static str,
    on_close: Callback<()>,
    children: ChildrenFn,
) -> impl IntoView {
    let dialog = NodeRef::<html::Dialog>::new();
    Effect::new(move |_| {
        let Some(element) = dialog.get() else {
            return;
        };
        if open.get() {
            if !element.open() {
                // 內容中有 autofocus 的欄位或按鈕取得焦點
                let _ = element.show_modal();
            }
        } else if element.open() {
            element.close();
        }
    });
    let close = move || {
        if !busy.get_untracked() {
            on_close.run(());
        }
    };
    view! {
        <dialog
            node_ref=dialog
            aria-labelledby=labelled_by
            on:cancel=move |event: ev::Event| {
                if busy.get_untracked() {
                    event.prevent_default();
                }
            }
            on:close=move |_| {
                busy.set(false);
                on_close.run(());
            }
        >
            {move || {
                open.get()
                    .then(|| {
                        view! {
                            <div class="dialog-heading">
                                <h2 id=labelled_by>{title}</h2>
                                <button
                                    type="button"
                                    class="icon-button"
                                    aria-label="關閉視窗"
                                    disabled=move || busy.get()
                                    on:click=move |_| close()
                                >
                                    {art::static_svg(icons::CLOSE)}
                                </button>
                            </div>
                            <div class="dialog-content">{children()}</div>
                        }
                    })
            }}
        </dialog>
    }
}

/// 對話框底部的「取消」與送出按鈕。
#[component]
fn FormActions(
    busy: RwSignal<bool>,
    on_cancel: Callback<()>,
    label: &'static str,
    busy_label: &'static str,
    #[prop(optional)] danger: bool,
    /// 「取消」是對話框中第一個取得焦點的按鈕（沒有欄位的確認對話框）
    #[prop(optional)]
    focus_cancel: bool,
) -> impl IntoView {
    view! {
        <div class="form-actions">
            <button
                type="button"
                class="button quiet"
                autofocus=focus_cancel
                disabled=move || busy.get()
                on:click=move |_| on_cancel.run(())
            >
                "取消"
            </button>
            <button
                type="submit"
                class=if danger { "button danger" } else { "button primary" }
                disabled=move || busy.get()
            >
                {move || if busy.get() { busy_label } else { label }}
            </button>
        </div>
    }
}

/// 「編輯帳號」（需求 39.1、39.2、39.7）。
#[component]
fn EditUserForm(
    user: AdminUserDto,
    is_self: bool,
    busy: RwSignal<bool>,
    denied: RwSignal<bool>,
    on_cancel: Callback<()>,
    on_saved: Callback<AdminUserDto>,
) -> impl IntoView {
    let api = use_api();
    let id = user.id;
    let current = StoredValue::new((user.display_name.clone(), user.role));
    let name = RwSignal::new(user.display_name.clone());
    let role = RwSignal::new(user.role);
    let error = RwSignal::new(None::<String>);
    let submit = move |event: SubmitEvent| {
        event.prevent_default();
        if busy.get_untracked() {
            return;
        }
        let (current_name, current_role) = current.get_value();
        let display_name = match check_display_name(&name.get_untracked()) {
            Ok(display_name) => display_name,
            Err(violation) => {
                error.set(Some(violation.message().to_owned()));
                return;
            }
        };
        let new_role = role.get_untracked();
        // 只送出有變更的欄位；顯示名稱以 Participant_Name 正規化後比較（需求 39.2）
        let request = UpdateUserRequest {
            display_name: (display_name != current_name).then_some(display_name),
            role: (new_role != current_role).then_some(new_role),
        };
        if request.display_name.is_none() && request.role.is_none() {
            error.set(Some(NO_CHANGES.to_owned()));
            return;
        }
        error.set(None);
        busy.set(true);
        spawn_local(async move {
            let result = api.update_user(id, &request).await;
            busy.try_set(false);
            match result {
                Ok(updated) => on_saved.run(updated),
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        error.try_set(Some(failure_text(NOT_SAVED, &failure)));
                    }
                }
            }
        });
    };
    view! {
        <p class="dialog-note">"@"{user.username}</p>
        <form class="acct-form" novalidate aria-busy=move || busy.get().to_string() on:submit=submit>
            <div class="field">
                <label for="admin-edit-name">"顯示名稱"</label>
                <input
                    id="admin-edit-name"
                    name="admin-edit-name"
                    type="text"
                    required
                    autocomplete="off"
                    autofocus
                    prop:value=move || name.get()
                    on:input=move |event| name.set(event_target_value(&event))
                />
            </div>
            <div class="field">
                <label for="admin-edit-role">"角色"</label>
                <select
                    id="admin-edit-role"
                    name="admin-edit-role"
                    disabled=is_self
                    aria-describedby=is_self.then_some("admin-edit-role-help")
                    prop:value=move || role.get().as_str()
                    on:change=move |event| {
                        if let Some(next) = Role::parse(&event_target_value(&event)) {
                            role.set(next);
                        }
                    }
                >
                    <option value="member">"成員"</option>
                    <option value="admin">"管理員"</option>
                </select>
                {is_self
                    .then(|| {
                        view! {
                            <small class="help" id="admin-edit-role-help">
                                "不能變更自己的角色。"
                            </small>
                        }
                    })}
            </div>
            <p class="form-error" role="alert">
                {move || error.get()}
            </p>
            <FormActions busy on_cancel label="儲存" busy_label="儲存中…" />
        </form>
    }
}

/// 「重設密碼」（需求 36.1、36.2、36.8）。兩個密碼欄位只存在這個元件的 signal 中，不截斷輸入，也不寫入任何儲存空間
/// （需求 36.7）。
#[component]
fn ResetPasswordForm(
    user: AdminUserDto,
    is_self: bool,
    busy: RwSignal<bool>,
    denied: RwSignal<bool>,
    on_cancel: Callback<()>,
    on_done: Callback<(AdminUserDto, bool)>,
) -> impl IntoView {
    let api = use_api();
    let password = RwSignal::new(String::new());
    let again = RwSignal::new(String::new());
    let error = RwSignal::new(None::<String>);
    let explain = format!(
        "為 {}（@{}）設定新密碼。設定之後，這個帳號在每台裝置上都要以新密碼重新登入；請以安全的方式把新密碼告訴對方。",
        user.display_name, user.username
    );
    let is_disabled = user.is_disabled();
    let target = StoredValue::new(user);
    let submit = move |event: SubmitEvent| {
        event.prevent_default();
        if busy.get_untracked() {
            return;
        }
        let new_password = password.get_untracked();
        // 原樣檢查（需求 3.5），再確認兩次相同（需求 36.2）
        if let Err(violation) = check_password(&new_password) {
            error.set(Some(violation.message().to_owned()));
            return;
        }
        if again.with_untracked(|again| *again != new_password) {
            error.set(Some(PASSWORD_MISMATCH.to_owned()));
            return;
        }
        error.set(None);
        busy.set(true);
        let user = target.get_value();
        spawn_local(async move {
            let request = ResetPasswordRequest {
                password: new_password,
            };
            let result = api.reset_password(user.id, &request).await;
            busy.try_set(false);
            match result {
                Ok(()) => on_done.run((user, true)),
                // 需求 36.10：重設已經生效，只是沒有寫入操作紀錄
                Err(failure) if failure.code == PASSWORD_RESET_AUDIT_FAILED => {
                    on_done.run((user, false))
                }
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        error.try_set(Some(failure_text(NOT_SET, &failure)));
                    }
                }
            }
        });
    };
    view! {
        <div class="acct-delete-explain">
            <p>{explain}</p>
            {is_self.then(|| view! { <p>"這台裝置也需要重新登入。"</p> })}
            {is_disabled.then(|| view! { <p>"這個帳號目前已停用，啟用之後才能以新密碼登入。"</p> })}
        </div>
        <form class="acct-form" novalidate aria-busy=move || busy.get().to_string() on:submit=submit>
            <div class="field">
                <label for="admin-reset-password">"新密碼"</label>
                <input
                    id="admin-reset-password"
                    name="admin-reset-password"
                    type="password"
                    required
                    autocomplete="new-password"
                    autofocus
                    prop:value=move || password.get()
                    on:input=move |event| password.set(event_target_value(&event))
                />
            </div>
            <div class="field">
                <label for="admin-reset-again">"再次輸入新密碼"</label>
                <input
                    id="admin-reset-again"
                    name="admin-reset-again"
                    type="password"
                    required
                    autocomplete="new-password"
                    prop:value=move || again.get()
                    on:input=move |event| again.set(event_target_value(&event))
                />
            </div>
            <p class="form-error" role="alert">
                {move || error.get()}
            </p>
            <FormActions busy on_cancel label="設定新密碼" busy_label="設定中…" />
        </form>
    }
}

/// 「停用帳號」的確認（需求 40.2、40.7）。
#[component]
fn DisableUserForm(
    user: AdminUserDto,
    busy: RwSignal<bool>,
    denied: RwSignal<bool>,
    on_cancel: Callback<()>,
    on_done: Callback<AdminUserDto>,
) -> impl IntoView {
    let api = use_api();
    let error = RwSignal::new(None::<String>);
    let explain = format!(
        "停用後 {}（@{}）無法登入；已登入的裝置最晚在一小時內失效。旅行、旅伴與帳目都會保留，之後可以重新啟用。",
        user.display_name, user.username
    );
    let id = user.id;
    let submit = move |event: SubmitEvent| {
        event.prevent_default();
        if busy.get_untracked() {
            return;
        }
        error.set(None);
        busy.set(true);
        spawn_local(async move {
            let result = api.disable_user(id).await;
            busy.try_set(false);
            match result {
                Ok(updated) => on_done.run(updated),
                Err(failure) => {
                    if let Some(failure) = unhandled(failure, denied) {
                        error.try_set(Some(failure_text(NOT_DONE, &failure)));
                    }
                }
            }
        });
    };
    view! {
        <div class="acct-delete-explain">
            <p>{explain}</p>
        </div>
        <form class="acct-form" novalidate aria-busy=move || busy.get().to_string() on:submit=submit>
            <p class="form-error" role="alert">
                {move || error.get()}
            </p>
            <FormActions
                busy
                on_cancel
                label="停用帳號"
                busy_label="停用中…"
                danger=true
                focus_cancel=true
            />
        </form>
    }
}

#[cfg(test)]
mod tests {
    use super::password_set_toast;

    #[test]
    fn password_set_toast_mentions_a_missing_audit_entry() {
        assert_eq!(password_set_toast("小明", true), "已為 小明 設定新密碼");
        assert_eq!(
            password_set_toast("小明", false),
            "已為 小明 設定新密碼，但這次操作沒有寫入操作紀錄"
        );
    }
}
