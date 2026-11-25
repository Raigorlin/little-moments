//! 「邀請旅伴，名字讓他自己填」對話框（旅行頁的「邀請旅伴」按鈕開啟；`UiState::invite_open` 為真時顯示，需求 30.17）。
//!
//! 版面沿用 `renderAccountInviteDialog()` 的標題與說明，但只留下邀請網址：開啟時自動產生連結，不需要按「建立邀請連結」。
//!
//! - 產生的連結存在 `UiState::invite_link`（只在這個旅行頁）。再次開啟時先列出 Active_Invite：快取的連結還在清單中
//!   （尚未使用、撤銷或過期）就沿用，否則建立新的連結，所以重複開啟不會累積邀請。列出失敗時沿用快取的連結。
//!   伺服器只存 token 的雜湊（需求 30.2），重新整理頁面之後第一次開啟會建立新的連結。
//! - 連結下方提示「這個連結 7 天內有效（到期：…）。」；有效天數是 `lm_core::limits::INVITE_TTL_DAYS`。
//! - 「複製邀請網址」以剪貼簿複製；瀏覽器不提供剪貼簿時選取網址並請使用者手動複製。
//! - 建立被拒絕（例如已有 20 個有效連結）或網路錯誤時以 `.form-error` 顯示訊息與「再試一次」；401 不顯示（由登入流程處理）。
//!
//! 尚未使用的連結與「撤銷」在 Trip_Menu 的「邀請」中（`views::trip_menu`）。
use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::limits::INVITE_TTL_DAYS;
use uuid::Uuid;

use crate::api::use_api;
use crate::app::use_toasts;
use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::views::icons;
use crate::views::trip_menu::invite_time;

/// 建立失敗而且伺服器沒有給可顯示的訊息時。
const CREATE_FAILED: &str = "邀請連結沒有產生，請檢查網路後再試一次。";

/// 已產生的邀請連結。
#[derive(Clone, Debug, PartialEq)]
pub struct CreatedInvite {
    pub id: Uuid,
    /// 目前網頁的 origin 加上 `/invite/<token>`
    pub url: String,
    pub expires_at: String,
}

/// 「邀請旅伴，名字讓他自己填」。
#[component]
pub fn InviteDialog() -> impl IntoView {
    let TripContext { trip, ui, .. } = use_trip();
    let api = use_api();
    let toasts = use_toasts();
    let dialog = NodeRef::<html::Dialog>::new();
    let url_input = NodeRef::<html::Input>::new();
    let link = ui.invite_link;
    let busy = RwSignal::new(false);
    // 建立失敗：`Some(訊息)`；401 時訊息是空的
    let failure = RwSignal::new(None::<String>);

    // 沿用還有效的快取連結，否則建立一個
    let prepare = move || {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        failure.set(None);
        spawn_local(async move {
            if let Some(cached) = link.try_get_untracked().flatten() {
                match api.invites(trip).await {
                    Ok(list) if list.iter().any(|invite| invite.id == cached.id) => {
                        busy.try_set(false);
                        return;
                    }
                    Ok(_) => {
                        link.try_set(None);
                    }
                    // 無法確認時仍顯示快取的連結
                    Err(_) => {
                        busy.try_set(false);
                        return;
                    }
                }
            }
            match api.create_invite(trip).await {
                Ok(invite) => {
                    let origin = window().location().origin().unwrap_or_default();
                    link.try_set(Some(CreatedInvite {
                        id: invite.id,
                        url: format!("{origin}{}", invite.url_path),
                        expires_at: invite.expires_at,
                    }));
                }
                Err(error) => {
                    let text = if error.is_unauthorized() {
                        String::new()
                    } else if error.message.is_empty() {
                        CREATE_FAILED.to_owned()
                    } else {
                        error.message
                    };
                    failure.try_set(Some(text));
                }
            }
            busy.try_set(false);
        });
    };

    Effect::new(move |_| {
        let open = ui.invite_open.get();
        let Some(element) = dialog.get() else {
            return;
        };
        if open && !element.open() {
            let _ = element.show_modal();
            prepare();
        } else if !open && element.open() {
            element.close();
        }
    });
    // 連結出現時焦點移到邀請網址（現行 `focus='#invite-url'`）
    let shown =
        Memo::new(move |_| ui.invite_open.get() && !busy.get() && link.with(Option::is_some));
    Effect::new(move |_| {
        if shown.get() {
            if let Some(input) = url_input.get() {
                let _ = input.focus();
            }
        }
    });

    let close = move || match dialog.get_untracked() {
        Some(element) if element.open() => element.close(),
        _ => ui.invite_open.set(false),
    };
    let copy = move |_| {
        let Some(url) = link.with_untracked(|link| link.as_ref().map(|l| l.url.clone())) else {
            return;
        };
        spawn_local(async move {
            if write_clipboard(&url).await {
                toasts.show("已複製邀請網址");
            } else {
                if let Some(input) = url_input.get_untracked() {
                    input.select();
                }
                toasts.show("請選取邀請網址後手動複製");
            }
        });
    };

    let body = move || {
        if busy.get() {
            return view! { <p class="dialog-note" role="status">"正在產生邀請連結…"</p> }
                .into_any();
        }
        if let Some(text) = failure.get() {
            return view! {
                <p class="form-error" role="alert">
                    {text}
                </p>
                <div class="form-actions">
                    <button type="button" class="button primary" on:click=move |_| prepare()>
                        "再試一次"
                    </button>
                </div>
            }
            .into_any();
        }
        let Some(invite) = link.get() else {
            return ().into_any();
        };
        view! {
            <label class="field">
                <span>"邀請網址"</span>
                <input id="invite-url" type="text" readonly value=invite.url node_ref=url_input />
            </label>
            <p class="dialog-note">
                {format!(
                    "這個連結 {INVITE_TTL_DAYS} 天內有效（到期：{}）。",
                    invite_time(&invite.expires_at),
                )}
            </p>
            <div class="form-actions">
                <button type="button" class="button primary" on:click=copy>
                    {art::static_svg(icons::LINK)}
                    "複製邀請網址"
                </button>
            </div>
        }
        .into_any()
    };

    view! {
        <dialog
            node_ref=dialog
            aria-labelledby="invite-dialog-title"
            on:close=move |_| ui.invite_open.set(false)
        >
            <div class="dialog-heading">
                <h2 id="invite-dialog-title">"邀請旅伴，名字讓他自己填"</h2>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="關閉視窗"
                    on:click=move |_| close()
                >
                    {art::static_svg(icons::CLOSE)}
                </button>
            </div>
            <div class="dialog-content">
                <p>"對方用邀請連結登入或建立帳號後，再自行填寫這趟旅行使用的名字。"</p>
                {body}
            </div>
        </dialog>
    }
}

/// 以 `navigator.clipboard.writeText()` 寫入純文字；瀏覽器不提供剪貼簿或拒絕寫入時回傳 `false`。
#[cfg(target_arch = "wasm32")]
async fn write_clipboard(text: &str) -> bool {
    use wasm_bindgen::JsCast;
    let navigator = window().navigator();
    // 沒有剪貼簿時 `navigator.clipboard` 是 undefined，不能直接呼叫它的方法
    let clipboard = match js_sys::Reflect::get(&navigator, &"clipboard".into()) {
        Ok(value) if !value.is_undefined() && !value.is_null() => {
            value.unchecked_into::<web_sys::Clipboard>()
        }
        _ => return false,
    };
    wasm_bindgen_futures::JsFuture::from(clipboard.write_text(text))
        .await
        .is_ok()
}

/// 原生目標（只用於 `cargo clippy` 與 `cargo test` 的編譯）沒有剪貼簿。
#[cfg(not(target_arch = "wasm32"))]
async fn write_clipboard(_text: &str) -> bool {
    false
}
