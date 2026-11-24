//! `/login` 與 `/register`：沿用 `src/accounts-ui.js` 的 `renderAuth()` 的結構與 class（`.acct-auth`、
//! `.acct-auth-art`、`.acct-auth-copy`、`.acct-form`、`.field` 與 `.form-error`）。
//!
//! - 註冊：送出前先以 `normalize_username()`（Trim_White，再把 A–Z 轉成小寫）處理帳號名稱，密碼不做任何修改，再以
//!   LM_Core 的 `check_signup()` 依需求 3.2 至 3.5 的順序檢查，最後確認兩次密碼相同；不通過時不送出，只顯示第一個
//!   不通過項目的訊息（需求 3.14）。
//! - 成功時以 `Auth::set()` 保存 Session（需求 4.3）。Session 一出現，App 外框的路由就依需求 4.10 以 `replace` 前往
//!   `next` 或這個 Account 的 Home_Page（`login_destination()`，需求 3.15 與 4.10 相同）；`Auth::set()` 換了 access
//!   token，所以已登記的 `SessionHooks::token_changed` 以新的 Session 依原本的順序送出同一個 Account 的
//!   Pending_Command（需求 4.10），屬於另一個 Account 時則依需求 4.14 捨棄。
//! - 被拒絕時在表單顯示回應的 `message`，表單中已輸入的內容都保留（需求 3.15）。
use gloo_storage::{SessionStorage, Storage as _};
use leptos::ev::SubmitEvent;
use leptos::prelude::*;
use leptos::task::spawn_local;
use leptos_router::hooks::use_url;
use leptos_router::location::Url;
use lm_core::account::{check_signup, normalize_username, PASSWORD_MISMATCH};
use lm_core::api::{LoginRequest, SignupRequest};

use crate::api::use_api;
use crate::app::{is_in_app_path, Shell};
use crate::art::{self, Illustration};
use crate::session::use_auth;

/// 登入表單少了帳號名稱或密碼時的訊息（同現行）。
const MISSING_LOGIN: &str = "請輸入帳號名稱與密碼。";
/// 送出期間按鈕上的文字。
const BUSY_LABEL: &str = "處理中…";
/// 上一次顯示的插畫（sessionStorage，同現行的 `AUTH_ART_KEY`），使同一個分頁每次開啟換一張。
const ART_KEY: &str = "ggc-auth-art-index";
/// 輪流顯示的插畫。
const ART_KINDS: [(Illustration, &str); 2] = [
    (Illustration::Travel, "travel"),
    (Illustration::Night, "night"),
];

/// 登入或註冊。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    Login,
    Register,
}

/// 每種頁面的文字（`renderAuth()` 的 `copy`）。
struct PageCopy {
    title: &'static str,
    document_title: &'static str,
    eyebrow: &'static str,
    intro: &'static str,
    submit: &'static str,
}

impl AuthMode {
    const fn copy(self) -> PageCopy {
        match self {
            Self::Login => PageCopy {
                title: "登入日子拾光",
                document_title: "登入 · 日子拾光",
                eyebrow: "WELCOME BACK",
                intro: "登入後就能打開你的旅行手冊，和旅伴一起規劃。",
                submit: "登入",
            },
            Self::Register => PageCopy {
                title: "註冊旅伴帳號",
                document_title: "註冊旅伴帳號 · 日子拾光",
                eyebrow: "JOIN THE CREW",
                intro: "每位旅伴使用自己的帳號，旅行首頁只會顯示你建立或加入的旅行。",
                submit: "註冊並登入",
            },
        }
    }
}

/// 這次顯示的插畫（`nextAuthArtKind()`）：第一次隨機，之後與上一次不同。sessionStorage 無法使用時每次隨機。
fn next_art() -> (Illustration, &'static str) {
    let count = ART_KINDS.len();
    let random = |n: usize| ((js_sys::Math::random() * n as f64) as usize).min(n - 1);
    let storage = SessionStorage::raw();
    let previous = storage
        .get_item(ART_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<usize>().ok());
    let index = match previous {
        Some(previous) => (previous + 1 + random(count - 1)) % count,
        None => random(count),
    };
    let _ = storage.set_item(ART_KEY, &index.to_string());
    ART_KINDS[index]
}

/// 送出前的檢查與送出的請求。
enum Submit {
    Login(LoginRequest),
    Signup(SignupRequest),
}

/// 登入頁或註冊頁（只在沒有 Session 時顯示，需求 32.1）。
#[component]
pub fn AuthPage(mode: AuthMode) -> impl IntoView {
    let copy = mode.copy();
    document().set_title(copy.document_title);
    let auth = use_auth();
    let api = use_api();
    let url = use_url();
    // 只有 In_App_Path 的 next 才帶到另一個表單的連結與提示；登入後的目的地由路由依需求 4.10 決定
    let next = Memo::new(move |_| {
        url.with(|url| {
            url.search_params()
                .get_str("next")
                .filter(|next| is_in_app_path(next))
                .map(str::to_owned)
        })
    });
    let next_query = move || {
        next.with(|next| {
            next.as_deref()
                .map(|next| format!("?next={}", Url::escape(next)))
                .unwrap_or_default()
        })
    };
    let (art_kind, art_name) = next_art();

    let username = RwSignal::new(String::new());
    let display_name = RwSignal::new(String::new());
    let password = RwSignal::new(String::new());
    let confirm = RwSignal::new(String::new());
    let error = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error_ref = NodeRef::<leptos::html::P>::new();

    // `showFormError()`：顯示訊息並把焦點移到訊息上（文字更新之後才看得見，所以在下一個畫格移動焦點）
    let show_error = move |message: String| {
        let focus = !message.is_empty();
        error.set(message);
        if focus {
            request_animation_frame(move || {
                if let Some(element) = error_ref.get_untracked() {
                    let _ = element.focus();
                }
            });
        }
    };

    let on_submit = move |event: SubmitEvent| {
        event.prevent_default();
        if busy.get_untracked() {
            return;
        }
        // 帳號名稱先正規化，並把結果放回輸入框（同現行）；密碼原樣
        let name = normalize_username(&username.get_untracked());
        username.set(name.clone());
        let secret = password.get_untracked();
        let request = match mode {
            AuthMode::Login => {
                if name.is_empty() || secret.is_empty() {
                    show_error(MISSING_LOGIN.to_owned());
                    return;
                }
                Submit::Login(LoginRequest {
                    username: name,
                    password: secret,
                })
            }
            AuthMode::Register => {
                let checked = check_signup(&name, &display_name.get_untracked(), &secret);
                let normalized = match checked {
                    Ok(normalized) => normalized,
                    Err(violation) => {
                        show_error(violation.message().to_owned());
                        return;
                    }
                };
                if secret != confirm.get_untracked() {
                    show_error(PASSWORD_MISMATCH.to_owned());
                    return;
                }
                Submit::Signup(SignupRequest {
                    username: name,
                    display_name: normalized,
                    password: secret,
                    invite: None,
                })
            }
        };
        show_error(String::new());
        busy.set(true);
        spawn_local(async move {
            let result = match request {
                Submit::Login(request) => api.login(&request).await,
                Submit::Signup(request) => api.signup(&request).await.map(|signed| signed.session),
            };
            match result {
                Ok(session) => {
                    password.set(String::new());
                    confirm.set(String::new());
                    // 保存 Session；路由接著依需求 4.10 前往下一個畫面，這個頁面隨之移除，所以之後不再使用它的 signal
                    auth.set(session);
                }
                Err(failure) => {
                    // 被拒絕（包括網路錯誤）：顯示訊息，已輸入的內容都保留
                    busy.set(false);
                    show_error(failure.message);
                }
            }
        });
    };

    let fields = match mode {
        AuthMode::Login => view! {
            <TextField
                id="auth-username"
                label="帳號名稱"
                value=username
                autocomplete="username"
                maxlength="32"
                plain=true
            />
            <TextField
                id="auth-password"
                label="密碼"
                kind="password"
                value=password
                autocomplete="current-password"
                maxlength="72"
            />
        }
        .into_any(),
        AuthMode::Register => view! {
            <TextField
                id="auth-username"
                label="帳號名稱（網址用）"
                help="3–32 個字元，小寫英文字母開頭，可用小寫英文字母、數字或連字號，例如 xiao-an。會出現在你的首頁網址 /帳號名稱/home。"
                value=username
                autocomplete="username"
                minlength="3"
                maxlength="32"
                plain=true
            />
            <TextField
                id="auth-display"
                label="顯示名稱"
                help="旅伴看到的名字，最多 30 個字，可以使用中文。"
                value=display_name
                autocomplete="nickname"
                maxlength="30"
            />
            <TextField
                id="auth-password"
                label="密碼"
                kind="password"
                help="12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。"
                value=password
                autocomplete="new-password"
                minlength="12"
                maxlength="72"
            />
            <TextField
                id="auth-confirm"
                label="再次輸入密碼"
                kind="password"
                value=confirm
                autocomplete="new-password"
                minlength="12"
                maxlength="72"
            />
        }
        .into_any(),
    };

    let links = move || match mode {
        AuthMode::Login => view! {
            <p class="help">
                "還沒有帳號？"
                <a class="text-link" href=format!("/register{}", next_query())>
                    "註冊旅伴帳號"
                </a>
            </p>
        },
        AuthMode::Register => view! {
            <p class="help">
                "已經有帳號了？"
                <a class="text-link" href=format!("/login{}", next_query())>
                    "前往登入"
                </a>
            </p>
        },
    };

    let next_note = move || {
        next.get().map(|next| {
            let text = if next.starts_with("/invite/") {
                "完成後會帶你回到旅行邀請頁。"
            } else {
                "完成後會帶你回到剛才的頁面。"
            };
            view! {
                <p class="notice">{art::static_svg(art::ICON_INFO)}<span>{text}</span></p>
            }
        })
    };

    view! {
        <Shell>
            <section class="acct-auth">
                <div class=format!("acct-auth-art acct-auth-art--{art_name}")>
                    <div class="acct-auth-scene">{art::static_svg(art_kind.svg())}</div>
                </div>
                <div class="acct-auth-copy">
                    <span class="eyebrow">{copy.eyebrow}</span>
                    <h1>{copy.title}</h1>
                    <p>{copy.intro}</p>
                    {next_note}
                    <form
                        class="acct-form"
                        novalidate
                        aria-busy=move || busy.get().to_string()
                        on:submit=on_submit
                    >
                        {fields}
                        <p class="form-error" role="alert" tabindex="-1" node_ref=error_ref>
                            {move || error.get()}
                        </p>
                        <button
                            class="button primary full"
                            type="submit"
                            disabled=move || busy.get()
                        >
                            {move || if busy.get() { BUSY_LABEL } else { copy.submit }}
                        </button>
                    </form>
                    {links}
                </div>
            </section>
        </Shell>
    }
}

/// 一個輸入欄位（`field()`）：`<div class="field">` 中的 label、input 與選填的說明（以 `aria-describedby` 連結）。
/// 值以 `value` 雙向綁定，送出失敗時保留。`plain` 時關閉自動大寫與拼字檢查（帳號名稱）；`optional` 時不加
/// `required`（Invite_Page 的旅伴名字與角色）。
#[component]
pub(crate) fn TextField(
    id: &'static str,
    label: &'static str,
    value: RwSignal<String>,
    autocomplete: &'static str,
    #[prop(default = "text")] kind: &'static str,
    #[prop(optional)] help: Option<&'static str>,
    #[prop(optional)] minlength: Option<&'static str>,
    #[prop(optional)] maxlength: Option<&'static str>,
    #[prop(optional)] plain: bool,
    #[prop(optional)] optional: bool,
) -> impl IntoView {
    let help_id = help.map(|_| format!("{id}-help"));
    view! {
        <div class="field">
            <label for=id>{label}</label>
            <input
                id=id
                name=id
                type=kind
                required=!optional
                autocomplete=autocomplete
                autocapitalize=plain.then_some("none")
                spellcheck=plain.then_some("false")
                minlength=minlength
                maxlength=maxlength
                aria-describedby=help_id.clone()
                prop:value=move || value.get()
                on:input=move |event| value.set(event_target_value(&event))
            />
            {help.map(|help| view! { <small class="help" id=help_id>{help}</small> })}
        </div>
    }
}
