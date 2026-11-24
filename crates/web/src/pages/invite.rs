//! Invite_Page（`/invite/<token>`）：邀請的預覽、以目前的 Account 加入，以及以連結註冊（需求 30.9、30.18）。
//!
//! 沿用 `src/accounts-ui.js` 的 `renderInvite()` 與 `renderInviteRegistration()` 的結構與 class（`.invite-page`、
//! `.acct-invite`、`.invite-card`、`.invite-art`、`.invite-content`、`.invite-date`、`.invite-intro`、`.acct-form`）。
//!
//! - 預覽：`GET /api/invites/{token}`，已登入時帶 access token，回應才有 `already_member`（需求 30.16）。每次登入狀態換成
//!   另一個 Account（或登出、登入）時重新讀取，所以另一個分頁登入後，這個分頁改顯示加入表單。
//! - 已是 Trip_Member：顯示說明與前往 Home_Page 的連結，不顯示表單（需求 30.9）。
//! - 不是 Trip_Member：已登入時是預先填入 Display_Name 的旅伴名字與選填的角色（`POST /api/invites/{token}/join`）；
//!   未登入時是註冊表單（`POST /api/auth/signup` 附 `invite`），送出前依需求 3.14 檢查，旅伴名字留空時以正規化後的
//!   顯示名稱代替，成功時以 `Auth::set()` 保存 Session（需求 4.3）。兩者成功後都前往
//!   `/<帳號名稱>/trips/<旅行 id>`（需求 30.18）。
//! - 預覽、加入或註冊回應 `invite_invalid`（404）時顯示「邀請連結無效或已過期。」（需求 30.13、6.16）；其他錯誤在表單
//!   顯示回應的 `message`，已輸入的內容都保留。
//!
//! 使用者文字（旅行名稱、目的地、顯示名稱）一律以文字節點輸出；只有插畫與介面圖示以 `art::static_svg()` 放進畫面
//! （需求 32.6）。
use leptos::ev::{MouseEvent, SubmitEvent};
use leptos::prelude::*;
use leptos::task::spawn_local;
use leptos_router::hooks::use_navigate;
use lm_core::account::{check_signup, normalize_username, PASSWORD_MISMATCH};
use lm_core::api::{InviteJoin, InvitePreview, JoinRequest, ProfileDto, SignupRequest};
use lm_core::text::participant_name;

use crate::api::{use_api, ApiFailure};
use crate::app::{home_path, login_path, trip_path, Shell};
use crate::art::{self, Illustration};
use crate::pages::auth::TextField;
use crate::pages::home::{date_span, ICON_CALENDAR, ICON_PEOPLE, ICON_PIN};
use crate::session::use_auth;

/// LM_Server 對無效邀請連結的錯誤代碼（需求 30.13）。
const INVALID_CODE: &str = "invite_invalid";
/// 無效邀請連結的訊息（需求 30.13）；LM_Server 的回應沒有 `message` 時使用。
const INVALID_MESSAGE: &str = "邀請連結無效或已過期。";
/// 目的地空白時（需求 30.9）。
const NO_DESTINATION: &str = "地點尚未填寫";
/// 已是 Trip_Member 時的說明（需求 30.9）。
const ALREADY_MEMBER: &str = "你已經是這趟旅行的成員了，可以從旅行首頁打開手冊。";

/// 預覽的狀態。
#[derive(Clone)]
enum State {
    Loading,
    /// 預覽，以及讀取時的登入狀態（決定顯示哪一種表單）
    Ready(InvitePreview, Option<ProfileDto>),
    /// 連結無效或已過期（需求 30.13）
    Invalid(String),
    /// 其他錯誤（網路錯誤、429 或 5xx），可以重新讀取
    Failed(String),
}

/// 回應是不是「邀請連結無效或已過期。」。
fn is_invalid(failure: &ApiFailure) -> bool {
    failure.code == INVALID_CODE
}

/// Invite_Page；有沒有 Session 都可以開啟。
#[component]
pub fn InvitePage(token: String) -> impl IntoView {
    document().set_title("旅行邀請 · 日子拾光");
    let api = use_api();
    let auth = use_auth();
    let user = auth.user();
    let token = StoredValue::new(token);
    let state = RwSignal::new(State::Loading);
    // 加入或註冊成功、正要前往 Trip_Page：註冊保存的 Session 不再觸發重新讀取
    let leaving = RwSignal::new(false);

    // 重新讀取時只採用最後一次請求的結果
    let loads = StoredValue::new(0_u64);
    let load = move || {
        let id = loads.get_value() + 1;
        loads.set_value(id);
        state.set(State::Loading);
        let viewer = user.get_untracked();
        spawn_local(async move {
            let result = api.invite_preview(&token.get_value()).await;
            if loads.try_get_value() != Some(id) {
                return;
            }
            state.set(match result {
                // 送出時才確認登入狀態（access token 可能在換發時被拒絕），所以以回應中的 already_member 為準
                Ok(preview) => {
                    let viewer = viewer.filter(|_| preview.already_member.is_some());
                    State::Ready(preview, viewer)
                }
                Err(failure) if is_invalid(&failure) => State::Invalid(failure.message),
                Err(failure) => State::Failed(failure.message),
            });
        });
    };
    // 登入狀態換成另一個 Account、登入或登出時重新讀取（第一次執行即是開啟頁面時的讀取）
    let viewer_id = Memo::new(move |_| user.with(|user| user.as_ref().map(|user| user.id)));
    Effect::new(move |_| {
        viewer_id.track();
        if !leaving.get_untracked() {
            load();
        }
    });
    let retry = move |_: MouseEvent| load();
    let on_invalid = Callback::new(move |message: String| state.set(State::Invalid(message)));

    let content = move || match state.get() {
        State::Loading => view! {
            <p class="acct-loading" role="status">
                "正在讀取邀請…"
            </p>
        }
        .into_any(),
        State::Invalid(message) => view! { <InvalidInvite message /> }.into_any(),
        State::Failed(message) => view! {
            <h1>"無法讀取邀請"</h1>
            <div class="acct-error" role="alert">
                <p>{message}</p>
                <div class="acct-actions">
                    <button type="button" class="button small" on:click=retry>
                        "重新整理"
                    </button>
                </div>
            </div>
            <BackLink />
        }
        .into_any(),
        State::Ready(preview, viewer) => {
            let summary = view! { <Summary preview=preview.clone() /> };
            let token = token.get_value();
            match viewer {
                Some(viewer) if preview.already_member == Some(true) => view! {
                    {summary}
                    <p class="invite-intro">{ALREADY_MEMBER}</p>
                    <a class="button primary" href=home_path(&viewer.username)>
                        "回到我的旅行首頁"
                    </a>
                }
                .into_any(),
                Some(viewer) => view! {
                    {summary}
                    <JoinForm token user=viewer leaving on_invalid />
                }
                .into_any(),
                None => view! {
                    {summary}
                    <SignupForm token leaving on_invalid />
                }
                .into_any(),
            }
        }
    };

    view! {
        <Shell>
            <div class="invite-page acct-invite">
                <div class="invite-card">
                    <div class="invite-art">{art::static_svg(Illustration::Camp.svg())}</div>
                    <div class="invite-content">{content}</div>
                </div>
            </div>
        </Shell>
    }
}

/// 預覽（`inviteSummary()`）：旅行名稱、起訖日期、目的地與「{建立者} 邀請你加入」（需求 30.9）。
#[component]
fn Summary(preview: InvitePreview) -> impl IntoView {
    let destination = if preview.destination.trim().is_empty() {
        NO_DESTINATION.to_owned()
    } else {
        preview.destination
    };
    view! {
        <span class="eyebrow">"YOU'RE INVITED"</span>
        <h1>{preview.title}</h1>
        <p class="invite-date">
            {art::static_svg(ICON_CALENDAR)}{date_span(preview.start, preview.end)}
        </p>
        <p class="invite-date">{art::static_svg(ICON_PIN)}{destination}</p>
        <p class="invite-date">
            {art::static_svg(ICON_PEOPLE)}{preview.inviter_name}" 邀請你加入"
        </p>
    }
}

/// 連結無效或已過期（`invalidInvite()`）。
#[component]
fn InvalidInvite(message: String) -> impl IntoView {
    let message = if message.is_empty() {
        INVALID_MESSAGE.to_owned()
    } else {
        message
    };
    view! {
        <h1>"邀請連結無效或已過期"</h1>
        <div class="acct-error" role="alert">
            <p>{message}</p>
        </div>
        <BackLink />
    }
}

/// 已登入時回到 Home_Page，未登入時前往 `/login`。
#[component]
fn BackLink() -> impl IntoView {
    let user = use_auth().user();
    move || match user.get() {
        Some(user) => view! {
            <a class="button" href=home_path(&user.username)>
                "回到我的旅行首頁"
            </a>
        }
        .into_any(),
        None => view! {
            <a class="button primary" href="/login">
                "前往登入"
            </a>
        }
        .into_any(),
    }
}

/// 表單的錯誤訊息與送出狀態（`showFormError()` 與 `setBusy()`）。
#[derive(Clone, Copy)]
struct FormStatus {
    error: RwSignal<String>,
    busy: RwSignal<bool>,
    error_ref: NodeRef<leptos::html::P>,
}

impl FormStatus {
    fn new() -> Self {
        Self {
            error: RwSignal::new(String::new()),
            busy: RwSignal::new(false),
            error_ref: NodeRef::new(),
        }
    }

    /// 顯示訊息並把焦點移到訊息上（文字更新之後才看得見，所以在下一個畫格移動焦點）。
    fn show(self, message: String) {
        let focus = !message.is_empty();
        self.error.set(message);
        if focus {
            let error_ref = self.error_ref;
            request_animation_frame(move || {
                if let Some(element) = error_ref.get_untracked() {
                    let _ = element.focus();
                }
            });
        }
    }
}

/// 表單的錯誤訊息與送出按鈕。
#[component]
fn FormFooter(status: FormStatus, label: &'static str, busy_label: &'static str) -> impl IntoView {
    view! {
        <p class="form-error" role="alert" tabindex="-1" node_ref=status.error_ref>
            {move || status.error.get()}
        </p>
        <button class="button primary full" type="submit" disabled=move || status.busy.get()>
            {move || if status.busy.get() { busy_label } else { label }}
        </button>
    }
}

/// 送出失敗：連結無效時改顯示無效的畫面，其他錯誤在表單顯示訊息（已輸入的內容保留）。Session 已失效（401）時登入狀態
/// 依需求 4.9 前往 `/login`，不顯示訊息。
fn handle_failure(failure: ApiFailure, status: FormStatus, on_invalid: Callback<String>) {
    status.busy.set(false);
    if is_invalid(&failure) {
        on_invalid.run(failure.message);
    } else if !failure.is_unauthorized() {
        status.show(failure.message);
    }
}

/// 已登入、還不是 Trip_Member 時的加入表單（需求 30.18）：旅伴名字預先填入 Display_Name，角色選填。
#[component]
fn JoinForm(
    token: String,
    user: ProfileDto,
    leaving: RwSignal<bool>,
    on_invalid: Callback<String>,
) -> impl IntoView {
    let api = use_api();
    let navigate = use_navigate();
    let token = StoredValue::new(token);
    let username = StoredValue::new(user.username.clone());
    let name = RwSignal::new(user.display_name.clone());
    let role = RwSignal::new(String::new());
    let status = FormStatus::new();

    let on_submit = move |event: SubmitEvent| {
        event.prevent_default();
        if status.busy.get_untracked() {
            return;
        }
        // 名字與角色由 LM_Server 以 LM_Core 依需求 19.1–19.7 檢查（需要整趟旅行的旅伴才能檢查重名）
        let request = JoinRequest {
            name: name.get_untracked(),
            role: role.get_untracked(),
        };
        status.show(String::new());
        status.busy.set(true);
        let navigate = navigate.clone();
        spawn_local(async move {
            match api.join_invite(&token.get_value(), &request).await {
                Ok(joined) => {
                    leaving.set(true);
                    navigate(
                        &trip_path(&username.get_value(), joined.trip_id),
                        Default::default(),
                    );
                }
                Err(failure) => handle_failure(failure, status, on_invalid),
            }
        });
    };

    view! {
        <p class="invite-intro">
            "你會以自己的帳號 "<b>{user.display_name}</b>"（@"{user.username}
            "）加入。請填寫你在這趟旅行裡的稱呼與角色；無法選擇或冒用其他旅伴的身分。"
        </p>
        <form
            class="acct-form"
            novalidate
            aria-busy=move || status.busy.get().to_string()
            on:submit=on_submit
        >
            <TextField
                id="join-name"
                label="你在這趟旅行的名字"
                help="最多 30 個字，不可和小隊裡其他人同名。"
                value=name
                autocomplete="nickname"
                maxlength="30"
            />
            <TextField
                id="join-role"
                label="小隊角色（選填）"
                help="例如：咖啡擔當、營火守護者。"
                value=role
                autocomplete="off"
                maxlength="60"
                optional=true
            />
            <FormFooter status label="加入這趟旅行" busy_label="加入中…" />
        </form>
    }
}

/// 未登入時以連結註冊（需求 30.12、30.18）：帳號名稱、顯示名稱、兩次密碼、旅伴名字（留空時用顯示名稱）與選填的角色。
#[component]
fn SignupForm(
    token: String,
    leaving: RwSignal<bool>,
    on_invalid: Callback<String>,
) -> impl IntoView {
    let api = use_api();
    let auth = use_auth();
    let navigate = use_navigate();
    let login_href = login_path(&format!("/invite/{token}"));
    let token = StoredValue::new(token);
    let username = RwSignal::new(String::new());
    let display_name = RwSignal::new(String::new());
    let password = RwSignal::new(String::new());
    let confirm = RwSignal::new(String::new());
    let name = RwSignal::new(String::new());
    let role = RwSignal::new(String::new());
    let status = FormStatus::new();

    let on_submit = move |event: SubmitEvent| {
        event.prevent_default();
        if status.busy.get_untracked() {
            return;
        }
        // 需求 3.14：帳號名稱先正規化並放回輸入框，密碼原樣；依需求 3.2 至 3.5 的順序檢查，最後確認兩次密碼相同
        let account = normalize_username(&username.get_untracked());
        username.set(account.clone());
        let secret = password.get_untracked();
        let normalized = match check_signup(&account, &display_name.get_untracked(), &secret) {
            Ok(normalized) => normalized,
            Err(violation) => {
                status.show(violation.message().to_owned());
                return;
            }
        };
        if secret != confirm.get_untracked() {
            status.show(PASSWORD_MISMATCH.to_owned());
            return;
        }
        // 旅伴名字留空（正規化後是空的）時以正規化後的顯示名稱代替（需求 30.18）
        let participant = match participant_name(&name.get_untracked()) {
            empty if empty.is_empty() => normalized.clone(),
            participant => participant,
        };
        let request = SignupRequest {
            username: account,
            display_name: normalized,
            password: secret,
            invite: Some(InviteJoin {
                token: token.get_value(),
                name: participant,
                role: role.get_untracked(),
            }),
        };
        status.show(String::new());
        status.busy.set(true);
        let navigate = navigate.clone();
        spawn_local(async move {
            match api.signup(&request).await {
                Ok(signed) => {
                    password.set(String::new());
                    confirm.set(String::new());
                    leaving.set(true);
                    let destination = match signed.trip_id {
                        Some(trip) => trip_path(&signed.session.user.username, trip),
                        None => home_path(&signed.session.user.username),
                    };
                    // 保存 Session（需求 4.3），再前往這趟旅行的 Trip_Page（需求 30.18）
                    auth.set(signed.session);
                    navigate(&destination, Default::default());
                }
                Err(failure) => handle_failure(failure, status, on_invalid),
            }
        });
    };

    view! {
        <p class="invite-intro">"建立你自己的帳號，完成後會直接加入這趟旅行。"</p>
        <p class="notice">
            {art::static_svg(art::ICON_INFO)}<span>"這個邀請連結只能使用一次。"</span>
        </p>
        <form
            class="acct-form"
            novalidate
            aria-busy=move || status.busy.get().to_string()
            on:submit=on_submit
        >
            <TextField
                id="invite-username"
                label="帳號名稱（網址用）"
                help="3–32 個字元，小寫英文字母開頭，可用小寫英文字母、數字或連字號，例如 xiao-an。會出現在你的首頁網址 /帳號名稱/home。"
                value=username
                autocomplete="username"
                minlength="3"
                maxlength="32"
                plain=true
            />
            <TextField
                id="invite-display"
                label="顯示名稱"
                help="旅伴看到的名字，最多 30 個字，可以使用中文。"
                value=display_name
                autocomplete="nickname"
                maxlength="30"
            />
            <TextField
                id="invite-password"
                label="密碼"
                kind="password"
                help="12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。"
                value=password
                autocomplete="new-password"
                minlength="12"
                maxlength="72"
            />
            <TextField
                id="invite-confirm"
                label="再次輸入密碼"
                kind="password"
                value=confirm
                autocomplete="new-password"
                minlength="12"
                maxlength="72"
            />
            <TextField
                id="join-name"
                label="你在這趟旅行的名字"
                help="留空會使用顯示名稱。最多 30 個字，不可和小隊裡其他人同名。"
                value=name
                autocomplete="off"
                maxlength="30"
                optional=true
            />
            <TextField
                id="join-role"
                label="小隊角色（選填）"
                help="例如：咖啡擔當、營火守護者。"
                value=role
                autocomplete="off"
                maxlength="60"
                optional=true
            />
            <FormFooter status label="建立帳號並加入" busy_label="處理中…" />
        </form>
        <p class="help">
            <a class="text-link" href=login_href>
                "已經有帳號？登入後加入"
            </a>
        </p>
    }
}
