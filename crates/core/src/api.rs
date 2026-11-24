//! HTTP API 的請求與回應型別（design 1.8），LM_Server 與 LM_Web 共用。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::command::{Command, Input, TripDraft};
use crate::ids::{CommandId, TripId, UserId};
use crate::model::{CoverKind, Date, Role, Seq, TripStatus};
use crate::sync::ChangeSet;

/// `POST /api/trips/{id}/commands` 的請求：一個 Command_Id 與一個 Command（需求 7.1）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandRequest {
    pub command_id: CommandId,
    pub command: Command,
}

/// `POST /api/trips/{id}/commands` 的回應：沒有變化時 `changeset` 是 `null`，`seq` 是目前的 Head（需求 7.12）；
/// Command_Id 已提交過時回傳第一次的 Change_Set，`replayed` 為真（需求 7.14）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResponse {
    pub seq: Seq,
    pub changeset: Option<ChangeSet>,
    #[serde(default)]
    pub replayed: bool,
}

/// `GET /api/trips/{id}/changes?after=N` 的回應：落後 Head 超過 500 時改讀 Snapshot（需求 12.5）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChangesResponse {
    /// `after` 之後的每一個 Change_Set，依 Seq 遞增。
    Changes {
        head: Seq,
        changesets: Vec<ChangeSet>,
    },
    SnapshotRequired {
        head: Seq,
    },
}

/// `GET /api/trips/{id}/head` 的回應：這趟旅行目前的 Head，還沒有任何有變化的提交時是 0（需求 12.9）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadResponse {
    pub seq: Seq,
}

/// 錯誤回應只有這三個欄位（需求 5.5）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub field: Option<String>,
}

/// 註冊（需求 3）；附邀請時同時加入旅行（需求 30）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignupRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
    #[serde(default)]
    pub invite: Option<InviteJoin>,
}

/// 以邀請連結加入時的旅伴名字與角色（角色是選填的）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteJoin {
    pub token: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
}

/// 登入（需求 4）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// 換發 Session（需求 4.5）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// 一個 Session：access token、refresh token、到期時間（Unix 秒）與帳號。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDto {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user: ProfileDto,
}

/// 註冊的回應：Session，附邀請時另帶加入的旅行 id，讓 Invite_Page 直接前往 Trip_Page（需求 30.18）；沒有邀請時為
/// `null`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignupResponse {
    #[serde(flatten)]
    pub session: SessionDto,
    pub trip_id: Option<TripId>,
}

/// 以目前的 Account 經邀請連結加入（`POST /api/invites/{token}/join`，需求 30.10）：旅伴名字與選填的角色。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinRequest {
    pub name: String,
    #[serde(default)]
    pub role: String,
}

/// 以邀請連結加入的回應（需求 30.10、30.11）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinResponse {
    pub trip_id: TripId,
}

/// 帳號（`GET /api/me`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileDto {
    pub id: UserId,
    pub username: String,
    pub display_name: String,
    pub role: Role,
}

/// 旅行列表的一趟旅行（需求 17.8）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TripSummary {
    pub id: TripId,
    pub title: String,
    pub destination: String,
    pub start: Date,
    pub end: Date,
    pub cover: CoverKind,
    pub status: TripStatus,
    /// 旅伴人數，包括沒有綁定帳號的旅伴。
    pub member_count: u32,
    /// 請求者是不是這趟旅行的 Trip_Manager。
    pub can_manage: bool,
}

/// 建立旅行（需求 17.3、17.5）：旅行 id 由用戶端在開啟表單時產生，同一個表單的每次送出都使用這個 id（需求 17.9）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateTripRequest {
    pub id: TripId,
    pub title: String,
    pub start: Date,
    pub end: Date,
    #[serde(default)]
    pub destination: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub note: String,
    /// 七種封面之一；無法解析時依需求 17.5 以「請選擇封面插畫。」拒絕。
    pub cover: Input<CoverKind>,
}

impl CreateTripRequest {
    /// 給 `apply::new_trip_card()` 檢查的內容。
    pub fn draft(&self) -> TripDraft {
        TripDraft {
            title: self.title.clone(),
            destination: self.destination.clone(),
            start: self.start,
            end: self.end,
            description: self.description.clone(),
            note: self.note.clone(),
            cover: self.cover.clone(),
        }
    }
}

/// 建立邀請連結的回應：token 只在這個回應中回傳（需求 30.2）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteCreated {
    pub id: Uuid,
    pub token: String,
    /// `/invite/<token>`。
    pub url_path: String,
    pub expires_at: String,
}

/// 邀請連結的列表（需求 30.5）：依建立時間由新到舊，附建立者的 Display_Name。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteListItem {
    pub id: Uuid,
    pub creator_name: String,
    pub created_at: String,
    pub expires_at: String,
}

/// 邀請連結的預覽（需求 30.9）：有 Valid_Access_Token 時另回 `already_member`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePreview {
    pub title: String,
    pub destination: String,
    pub start: Date,
    pub end: Date,
    pub inviter_name: String,
    pub already_member: Option<bool>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn changes_responses_are_tagged_by_status() {
        let value = serde_json::to_value(ChangesResponse::SnapshotRequired { head: 812 })
            .expect("可以序列化");
        assert_eq!(value, json!({"status": "snapshot_required", "head": 812}));
        let changes: ChangesResponse =
            serde_json::from_value(json!({"status": "changes", "head": 3, "changesets": []}))
                .expect("可以解析");
        assert_eq!(
            changes,
            ChangesResponse::Changes {
                head: 3,
                changesets: Vec::new()
            }
        );
    }

    #[test]
    fn signup_responses_flatten_the_session() {
        let response = SignupResponse {
            session: SessionDto {
                access_token: "a".to_owned(),
                refresh_token: "r".to_owned(),
                expires_at: 1_795_000_000,
                user: ProfileDto {
                    id: UserId(Uuid::nil()),
                    username: "amy".to_owned(),
                    display_name: "Amy".to_owned(),
                    role: Role::Member,
                },
            },
            trip_id: None,
        };
        let value = serde_json::to_value(&response).expect("可以序列化");
        assert_eq!(value["access_token"], "a");
        assert_eq!(value["trip_id"], json!(null));
        assert_eq!(
            serde_json::from_value::<SignupResponse>(value).expect("可以解析"),
            response
        );
    }

    #[test]
    fn create_trip_requests_keep_covers_that_do_not_parse() {
        let request: CreateTripRequest = serde_json::from_value(json!({
            "id": Uuid::nil(), "title": "週末露營", "start": "2026-11-20", "end": "2026-11-22",
            "cover": "volcano"
        }))
        .expect("可以解析");
        assert_eq!(request.cover, Input::Bad(json!("volcano")));
        assert_eq!(request.draft().destination, "");
    }
}
