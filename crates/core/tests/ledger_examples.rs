//! 分帳計算的範例測試（任務 7.3；需求 33.1）。
//!
//! 移植 Bun_App 測試中以固定輸入斷言分帳計算的案例：輸入與原案例相同，預期值與原案例相同並直接寫在測試中，也就是
//! Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試檔與測試名稱，`describe` 之內的測試寫成
//! 「describe › test」。原案例只斷言丟出錯誤、與另一次呼叫的結果相同，或只檢查守恆的三個測試，另外比對 Bun_App 對
//! 同一輸入的實際結果（以 Bun 執行 `src/expense-model.js` 取得），並在該測試的註解中標明。
//!
//! - `tests/expense-model.test.js`（`parseAmount()`、`formatMoney()`、`splitEvenly()` 與 `summarizeLedger()`）：16 個
//!   測試移植 13 個，其中 3 個各有一部分斷言不移植；不移植的 3 個測試與這些斷言列在下面。
//! - `tests/ledger.test.js` 的 23 個測試都經過帳本 API（`GET` 與 `PUT /api/trips/:id/ledger`）。其中 3 個以
//!   `summarizeLedger()` 計算伺服器回傳的帳本，移植這些計算的斷言；這 3 個測試的其他斷言與另外 20 個測試列在下面。
//!
//! 現行的資料寫成第一版的形式：
//!
//! - 傳入 `summarizeLedger()` 的帳本 `{ people, expenses, settlements }` 是 Trip_State 的旅伴、支出與還款
//!   （`ledger()`）：三個陣列依序逐一加入，每一列取得當時最大的 Ordinal 加 1，所以陣列的順序就是 Ordinal。現行結餘的
//!   `name` 是旅伴的名字；第一版的 `Balance` 沒有名字，畫面從旅伴取得，所以以結餘的旅伴在 Trip_State 中的名字比對
//!   （`names()`）。旅伴的角色、顏色與是否綁定帳號不影響分帳計算，一律是空的角色、coral 與沒有綁定。`summarize()`
//!   不讀 Trip_Card；Trip_State 需要 Trip_Card，一律使用 `tests/ledger.test.js` 的 `card`（`card()`）。
//! - 旅伴的字串 id 改為 UUID（`person()`）：字串的位元組依序放在 UUID 的開頭，其餘補 0，例如 `p1` 是
//!   `70310000-0000-0000-0000-000000000000`。`PersonId` 依位元組比較，所以順序與現行比較字串的順序相同（`p1` 在
//!   `p10` 之前，`gone-b` 在 `p1` 之前），`split_evenly()` 的餘數分給誰，以及金額相同的欠款者或應收者誰先轉帳都不變
//!   （需求 29.6、29.7）。`tests/ledger.test.js` 中由伺服器在建立與加入旅行時產生的 `owner.personId` 與
//!   `member.personId` 改為 `person("owner")` 與 `person("member")`；移植的斷言都與旅伴 id 的順序無關。支出 `e{n}` 與
//!   還款 `s{n}` 是 `id(Tag::Expense, n)` 與 `id(Tag::Settlement, n)`。
//! - 第一版的分攤旅伴是集合（`BTreeSet<PersonId>`），沒有順序也沒有重複，以原案例陣列中的 id 建立
//!   （`participants()`）。現行支出的 `shoppingId: ''` 是沒有連結採買品項；`source`、`receiptId` 與 `receiptLine` 是
//!   收據 AI 的欄位，第一版沒有。
//!
//! 不移植的案例與原因：
//!
//! - `tests/expense-model.test.js` 的 `parseAmount` › `parses TWD text and numbers into positive integer cents` 中
//!   `parseAmount(88)` 與 `parseAmount(19.99)` 的斷言，以及 `parseAmount` ›
//!   `rejects zero, negative, oversized, imprecise and malformed input` 中不是文字的 8 個輸入（`-5`、`0.1 + 0.2`、
//!   `1e21`、`NaN`、`Infinity`、`null`、`undefined` 與 `{}`）：現行的 `parseAmount()` 也接受 JavaScript 的 number 與
//!   其他型別的值。第一版的 `parse_amount()` 只換算金額欄位輸入的文字（需求 29.5）；Command 中的金額是整數的分，範圍
//!   由 `check_amount_cents()` 檢查，金額不是整數的 Command 依需求 7.20 以 400 拒絕，所以不會以 number、`null` 或物件
//!   換算金額。這兩個測試的文字輸入都移植。
//! - `formatMoney` › `rejects non-integer cents`：`format_money()` 的參數是 `i64` 的分，無法傳入 `1.5`、`NaN`、`'100'`
//!   與 `null`；`2 ** 60` 是 `i64` 可以表示的整數，第一版照樣顯示。現行拒絕超過 `Number.MAX_SAFE_INTEGER` 的值，是因為
//!   JavaScript 的 number 超過 2^53 − 1 之後不精確；第一版每筆帳目最多 100,000,000 分、支出與還款各最多 1,000 筆
//!   （需求 29.4、29.5），金額與總和都遠小於 2^53。
//! - `splitEvenly` › `rejects invalid amounts and participants`：第一版只為通過需求 29.2 檢查的支出（1–100,000,000 分、
//!   1–100 位不同的旅伴）分攤，design 也把「金額至少 1 分、分攤旅伴不是空的」列為 `split_evenly()` 的前置條件，所以它
//!   不檢查輸入，超出範圍時照同一個公式計算（見 `split_evenly()` 的說明）；分攤旅伴是 `BTreeSet<PersonId>`，也無法
//!   表示重複的 id、空字串、不是字串的 id 與不是陣列的 `'ab'`，金額 `1.5` 也不是 `i64`。拒絕這些支出的是新增與修改
//!   支出的命令，訊息依需求 29.2。
//! - `summarizeLedger` › `rejects non-integer money rows`：`summarize()` 的金額是 `i64`，無法表示 `1.5`；0 分的還款在
//!   記錄時就被命令以「金額必須大於 0。」拒絕（需求 29.3、29.5），`summarize()` 不再檢查金額。
//! - `summarizeLedger` › `deterministic for equal balances and keeps historical ids not in people` 中
//!   `a.balances[1].name` 為「已移除的旅伴」的斷言：第一版的 `Balance` 沒有名字，「誰該還誰」的名字取自旅伴
//!   （需求 29.11）；仍有帳目的旅伴不能移除（需求 19.14、I10），帳本也不另存旅伴的名字快照，所以沒有「已移除的旅伴」。
//!   同一個測試中結餘的順序與建議轉帳的斷言移植：`gone-a` 與 `gone-b` 不是旅伴，這個 Trip_State 不滿足 I10，
//!   `summarize()` 照樣計算，把它們依 id 排在旅伴之後（見 `summarize()` 的說明）。
//! - `tests/ledger.test.js` 中下列測試，以及移植的 3 個測試中 `summarizeLedger()` 以外的斷言：斷言帳本 API、帳本的
//!   伺服器儲存與 HTTP。第一版沒有帳本 API、帳本的 `revision` 與 `requestId`，也沒有 `trip_ledgers` 資料表；支出與
//!   還款是 Trip_State 的列，以 Command 新增、修改與刪除，帳目的檢查、上限與權限屬於命令的處理函式與權限判斷
//!   （需求 6、7、29），不是分帳計算。
//!   - `ledger read` › `GET returns an empty schema-1 ledger with trip people and permissions, without writing`、
//!     `unauthenticated, outsiders and non-member admins cannot see the ledger` 與
//!     `mutations require the same origin and JSON`。
//!   - `ledger write` › `text is trimmed and the response is the normalized server copy`、
//!     `stale revision and stale or missing identity are rejected without writing`、
//!     `identical retry with the same requestId is idempotent; reuse with a different body fails`、
//!     `members add and edit any row but cannot remove rows; owners can`、
//!     `backend rejects bad rows with Chinese messages and stores nothing`、
//!     `hostile nesting is rejected as 400 before hashing, never a stack overflow`、
//!     `row limits are 1000 expenses and 1000 settlements` 與
//!     `shopping links validate only when new or changed and never mark items bought`。
//!   - `ledger isolation and lifecycle` › `old whole-state PUT with stray money fields cannot change the ledger` 與
//!     `deleting the trip hides the ledger for everyone`。
//!   - `re-authentication after slow bodies` › `logout while the body is still uploading rejects the write`、
//!     `account deletion during upload rejects the write and ledger stays unchanged`、
//!     `a concurrent ledger save during upload makes the slow write stale` 與
//!     `trip deletion during upload rejects the write`。
//!   - `stored ledger rows` ›
//!     `migrated schema starts with an empty trip_ledgers table; GET writes nothing; corrupt rows are never overwritten`。
//! - `tests/ledger.test.js` 的 `ledger write` › `receipt rows need a fingerprint and unique line per file`：收據 AI 不在
//!   第一版的範圍內，支出也沒有 `source`、`receiptId` 與 `receiptLine`。
//! - `tests/ledger.test.js` 的 `ledger isolation and lifecycle` ›
//!   `removing an unbound participant in the trip keeps the name they had in the ledger`，以及
//!   `deleting a member account keeps their debt and name snapshot, never reassigning it` 中刪除帳號前後結餘相同等其他
//!   斷言：現行刪除帳號或移除旅伴之後，帳本以名字快照保留他們的帳目。第一版沒有帳號管理（範圍外），移除仍有帳目的
//!   旅伴以 409 拒絕（需求 19.14，也是 requirements.md「與現行版的差異」中的「移除旅伴」），帳本也不另存名字快照。
//!   後者中阿哲還款之後淨額為 0 的計算移植。

mod support;

use std::collections::{BTreeMap, BTreeSet};

use lm_core::ids::PersonId;
use lm_core::ledger::{
    format_money, parse_amount, split_evenly, summarize, Balance, LedgerSummary, Share, Transfer,
};
use lm_core::limits::AMOUNT_CENTS;
use lm_core::model::{
    Color, CoverKind, Date, Expense, ExpenseCategory, Person, Row, Settlement, TripCard, TripState,
    TripStatus,
};
use uuid::Uuid;

use support::ids::{id, Tag};

// ── tests/expense-model.test.js：parseAmount ──

// Bun_App 的 `parseAmount()` 丟出的訊息（需求 29.5）
/// 去除空白、幣別與「元」之後是空的。
const MISSING: &str = "請輸入金額。";
/// 以「-」開頭，或換算後為 0 分。
const NOT_POSITIVE: &str = "金額必須大於 0。";
/// 小數超過兩位。
const TOO_PRECISE: &str = "金額最多到小數點後兩位（角、分）。";
/// 超過 NT$1,000,000。
const TOO_LARGE: &str = "單筆金額最多 NT$1,000,000。";
/// 其他格式。
const INVALID: &str = "請輸入有效的金額，例如 350 或 120.5。";

/// 來源：`tests/expense-model.test.js` 的 `parseAmount` › `parses TWD text and numbers into positive integer cents`。
/// 數字輸入 `parseAmount(88)` 與 `parseAmount(19.99)` 的兩個斷言不移植（見檔頭）。
#[test]
fn parse_amount_converts_twd_text_to_positive_integer_cents() {
    for (input, cents) in [
        ("350", 35_000),
        ("120.5", 12_050),
        ("0.01", 1),
        (" NT$1,234.56 ", 123_456),
        ("$99", 9_900),
        // 「１２０元」：全形數字 U+FF11、U+FF12、U+FF10
        ("\u{ff11}\u{ff12}\u{ff10}元", 12_000),
        ("12.", 1_200),
    ] {
        assert_eq!(parse_amount(input), Ok(cents), "{input:?}");
    }
    // expect(parseAmount('1000000')).toBe(MAX_AMOUNT_CENTS)：現行的 MAX_AMOUNT_CENTS 是 100,000,000 分，也就是第一版
    // limits::AMOUNT_CENTS 的上限
    assert_eq!(*AMOUNT_CENTS.end(), 100_000_000);
    assert_eq!(parse_amount("1000000"), Ok(*AMOUNT_CENTS.end()));
}

/// 來源：`tests/expense-model.test.js` 的 `parseAmount` ›
/// `rejects zero, negative, oversized, imprecise and malformed input`。移植其中的 14 個文字輸入，依原案例的順序；
/// 不是文字的 8 個輸入不移植（見檔頭）。原案例只斷言丟出錯誤；這裡另外比對 Bun_App 對同一輸入丟出的訊息，也就是需求
/// 29.5 依輸入說明的訊息。
#[test]
fn parse_amount_rejects_zero_negative_oversized_imprecise_and_malformed_text() {
    for (input, message) in [
        ("", MISSING),
        ("  ", MISSING),
        ("0", NOT_POSITIVE),
        ("0.00", NOT_POSITIVE),
        ("-5", NOT_POSITIVE),
        ("1000000.01", TOO_LARGE),
        ("99999999", TOO_LARGE),
        ("1.234", TOO_PRECISE),
        ("abc", INVALID),
        ("1,23", INVALID),
        ("1e3", INVALID),
        ("12,345,6", INVALID),
        // 「١٢٣」：阿拉伯－印度數字 U+0661、U+0662、U+0663；NFKC 之後不變，不是半形數字 0–9
        ("\u{661}\u{662}\u{663}", INVALID),
        ("0x10", INVALID),
    ] {
        assert_eq!(
            parse_amount(input).map_err(|error| error.to_string()),
            Err(message.to_owned()),
            "{input:?}"
        );
    }
}

/// 來源：`tests/expense-model.test.js` 的 `parseAmount` › `error messages are Chinese and user-facing`。現行的
/// `toThrow(文字)` 檢查錯誤訊息含有這段文字。
#[test]
fn parse_amount_error_messages_are_chinese_and_user_facing() {
    for (input, part) in [
        ("-1", "金額必須大於 0。"),
        ("1.234", "小數點後兩位"),
        ("2000000", "NT$1,000,000"),
    ] {
        let Err(error) = parse_amount(input) else {
            panic!("{input:?} 應該被拒絕");
        };
        let message = error.to_string();
        assert!(
            message.contains(part),
            "{input:?} 的訊息「{message}」應該含有「{part}」"
        );
    }
}

// ── tests/expense-model.test.js：formatMoney ──

/// 來源：`tests/expense-model.test.js` 的 `formatMoney` ›
/// `prints TWD with grouping, cents only when present, negatives allowed`。
#[test]
fn format_money_groups_thousands_shows_cents_only_when_present_and_allows_negatives() {
    for (cents, text) in [
        (0, "NT$0"),
        (1, "NT$0.01"),
        (35_000, "NT$350"),
        (123_456, "NT$1,234.56"),
        (100_000_000, "NT$1,000,000"),
        (-12_050, "-NT$120.50"),
    ] {
        assert_eq!(format_money(cents), text, "{cents}");
    }
    assert_eq!(parse_amount(&format_money(123_456)), Ok(123_456));
}

// ── tests/expense-model.test.js：splitEvenly ──

/// 來源：`tests/expense-model.test.js` 的 `splitEvenly` ›
/// `conserves the total and gives remainders to the first sorted ids`。
#[test]
fn split_evenly_conserves_the_total_and_gives_remainders_to_the_first_sorted_ids() {
    assert_eq!(
        split_evenly(1000, &participants(&["c", "a", "b"])),
        [share("a", 334), share("b", 333), share("c", 333)]
    );
    assert_eq!(
        split_evenly(1, &participants(&["z", "y"])),
        [share("y", 1), share("z", 0)]
    );
    assert_eq!(
        split_evenly(500, &participants(&["solo"])),
        [share("solo", 500)]
    );
}

/// 來源：`tests/expense-model.test.js` 的 `splitEvenly` › `result is independent of input order`。第一版的分攤旅伴是
/// 集合，以兩種陣列順序建立的集合相同，所以原案例的比較在第一版一定成立；這裡另外比對 Bun_App 對同一輸入的結果：
/// 1001 分由 3 人分攤，多出的 2 分給 `p1` 與 `p2`。
#[test]
fn split_evenly_result_is_independent_of_input_order() {
    let result = split_evenly(1001, &participants(&["p3", "p1", "p2"]));
    assert_eq!(
        result,
        split_evenly(1001, &participants(&["p2", "p3", "p1"]))
    );
    assert_eq!(
        result,
        [share("p1", 334), share("p2", 334), share("p3", 333)]
    );
}

/// 來源：`tests/expense-model.test.js` 的 `splitEvenly` › `conservation holds across many amounts and group sizes`。
#[test]
fn split_evenly_conserves_across_many_amounts_and_group_sizes() {
    for n in 1..=13 {
        // const ids = Array.from({ length: n }, (_, i) => `p${i}`)
        let names: Vec<String> = (0..n).map(|i| format!("p{i}")).collect();
        let ids: Vec<&str> = names.iter().map(String::as_str).collect();
        let sharers = participants(&ids);
        for amount_cents in [1, 7, 99, 100, 101, 12_345, 99_999_999, 100_000_000] {
            let amounts: Vec<i64> = split_evenly(amount_cents, &sharers)
                .iter()
                .map(|share| share.amount_cents)
                .collect();
            assert_eq!(
                amounts.iter().sum::<i64>(),
                amount_cents,
                "{n} 人分攤 {amount_cents} 分：{amounts:?}"
            );
            let spread = amounts
                .iter()
                .max()
                .zip(amounts.iter().min())
                .map(|(max, min)| max - min);
            assert!(
                spread.is_some_and(|spread| spread <= 1),
                "{n} 人分攤 {amount_cents} 分，最多與最少相差超過 1 分：{amounts:?}"
            );
        }
    }
}

// ── tests/expense-model.test.js：summarizeLedger ──

/// 現行 `tests/expense-model.test.js` 中 `summarizeLedger` 的 `people`，依陣列的順序。
const PEOPLE: [(&str, &str); 4] = [
    ("p1", "小安"),
    ("p2", "阿哲"),
    ("p3", "小雨"),
    ("p4", "米米"),
];

/// 來源：`tests/expense-model.test.js` 的 `summarizeLedger` ›
/// `positive net means should receive; includes everyone in ledger.people`。
#[test]
fn positive_net_means_should_receive_and_every_person_is_included() {
    let state = ledger(
        &PEOPLE,
        vec![expense(1, 900, "p1", &["p1", "p2", "p3"])],
        Vec::new(),
    );
    let summary = summarize(&state);
    assert_eq!(summary.total_cents, 900);
    assert_eq!(summary.total_settled_cents, 0);
    assert_eq!(
        summary.balances,
        [
            balance("p1", 900, 300, 0, 0, 600),
            balance("p2", 0, 300, 0, 0, -300),
            balance("p3", 0, 300, 0, 0, -300),
            balance("p4", 0, 0, 0, 0, 0),
        ]
    );
    // 現行結餘的 name
    assert_eq!(names(&state, &summary), ["小安", "阿哲", "小雨", "米米"]);
    assert_eq!(
        summary.transfers,
        [transfer("p2", "p1", 300), transfer("p3", "p1", 300)]
    );
}

/// 來源：`tests/expense-model.test.js` 的 `summarizeLedger` ›
/// `repayments add to sender and subtract from receiver`。
#[test]
fn repayments_add_to_the_sender_and_subtract_from_the_receiver() {
    let state = ledger(
        &PEOPLE,
        vec![expense(1, 900, "p1", &["p1", "p2", "p3"])],
        vec![settle(1, "p2", "p1", 300)],
    );
    let summary = summarize(&state);
    // expect(by.p2).toMatchObject({ sentCents: 300, netCents: 0 })
    let p2 = balance_of(&summary, "p2");
    assert_eq!((p2.sent_cents, p2.net_cents), (300, 0));
    // expect(by.p1).toMatchObject({ receivedCents: 300, netCents: 300 })
    let p1 = balance_of(&summary, "p1");
    assert_eq!((p1.received_cents, p1.net_cents), (300, 300));
    assert_eq!(summary.total_settled_cents, 300);
    assert_eq!(summary.transfers, [transfer("p3", "p1", 300)]);
}

/// 來源：`tests/expense-model.test.js` 的 `summarizeLedger` ›
/// `overpaying a repayment flips direction instead of losing money`。
#[test]
fn overpaying_a_repayment_flips_the_direction_instead_of_losing_money() {
    let state = ledger(
        &PEOPLE,
        vec![expense(1, 200, "p1", &["p1", "p2"])],
        vec![settle(1, "p2", "p1", 150)],
    );
    assert_eq!(summarize(&state).transfers, [transfer("p1", "p2", 50)]);
}

/// 來源：`tests/expense-model.test.js` 的 `summarizeLedger` ›
/// `nets always sum to zero and transfers clear every balance, remainders included`。原案例只檢查守恆；最後另外比對
/// Bun_App 對同一輸入的結餘與建議轉帳，餘數依 id 分給 `p1`、`p2` 等排在前面的旅伴。
#[test]
fn nets_sum_to_zero_and_transfers_clear_every_balance_with_remainders() {
    let expenses = vec![
        expense(1, 1001, "p1", &["p1", "p2", "p3"]),
        expense(2, 777, "p2", &["p2", "p4"]),
        expense(3, 12_345, "p4", &["p1", "p2", "p3", "p4"]),
        expense(4, 1, "p3", &["p1", "p4"]),
    ];
    let state = ledger(&PEOPLE, expenses, vec![settle(1, "p3", "p4", 1000)]);
    let summary = summarize(&state);
    let total = |cents: fn(&Balance) -> i64| -> i64 { summary.balances.iter().map(cents).sum() };
    assert_eq!(total(|balance| balance.net_cents), 0);
    assert_eq!(total(|balance| balance.share_cents), summary.total_cents);
    // const left = Object.fromEntries(s.balances.map(b => [b.personId, b.netCents]))
    let mut left: BTreeMap<PersonId, i64> = summary
        .balances
        .iter()
        .map(|balance| (balance.person, balance.net_cents))
        .collect();
    for transfer in &summary.transfers {
        assert!(transfer.amount_cents > 0, "{transfer:?}");
        *left.entry(transfer.from).or_default() += transfer.amount_cents;
        *left.entry(transfer.to).or_default() -= transfer.amount_cents;
    }
    assert!(left.values().all(|&cents| cents == 0), "{left:?}");
    assert!(summary.transfers.len() <= 3, "{:?}", summary.transfers);

    // Bun_App 對同一輸入的結果
    assert_eq!(summary.total_cents, 14_124);
    assert_eq!(summary.total_settled_cents, 1_000);
    assert_eq!(
        summary.balances,
        [
            balance("p1", 1_001, 3_422, 0, 0, -2_421),
            balance("p2", 777, 3_809, 0, 0, -3_032),
            balance("p3", 1, 3_419, 1_000, 0, -2_418),
            balance("p4", 12_345, 3_474, 0, 1_000, 7_871),
        ]
    );
    assert_eq!(
        summary.transfers,
        [
            transfer("p2", "p4", 3_032),
            transfer("p1", "p4", 2_421),
            transfer("p3", "p4", 2_418),
        ]
    );
}

/// 來源：`tests/expense-model.test.js` 的 `summarizeLedger` ›
/// `deterministic for equal balances and keeps historical ids not in people`。`gone-a` 與 `gone-b` 不是旅伴；
/// `a.balances[1].name` 為「已移除的旅伴」的斷言不移植（見檔頭）。
#[test]
fn equal_balances_are_deterministic_and_ids_that_are_not_people_are_kept() {
    let state = ledger(
        &PEOPLE[..1],
        vec![expense(1, 300, "p1", &["p1", "gone-b", "gone-a"])],
        Vec::new(),
    );
    let summary = summarize(&state);
    let order: Vec<PersonId> = summary
        .balances
        .iter()
        .map(|balance| balance.person)
        .collect();
    assert_eq!(order, [person("p1"), person("gone-a"), person("gone-b")]);
    assert_eq!(
        summary.transfers,
        [transfer("gone-a", "p1", 100), transfer("gone-b", "p1", 100)]
    );
}

/// 來源：`tests/expense-model.test.js` 的 `summarizeLedger` › `empty ledger summarizes to zeros`。
#[test]
fn an_empty_ledger_summarizes_to_zeros() {
    assert_eq!(
        summarize(&ledger(&[], Vec::new(), Vec::new())),
        LedgerSummary {
            total_cents: 0,
            total_settled_cents: 0,
            balances: Vec::new(),
            transfers: Vec::new(),
        }
    );
}

// ── tests/ledger.test.js：summarizeLedger() 計算伺服器回傳的帳本 ──

/// 現行 `tests/ledger.test.js` 的 `world()` 中這趟旅行的旅伴：建立旅行的小安（`owner`），以及以邀請加入的阿哲
/// （`member`）。
const OWNER_AND_MEMBER: [(&str, &str); 2] = [("owner", "小安"), ("member", "阿哲")];

/// 來源：`tests/ledger.test.js` 的 `ledger write` ›
/// `PUT stores money rows separately; trip state and revision are untouched` 中 `summarizeLedger(env.ledger)` 的兩個
/// 斷言。帳本是 `firstLedger(w)` 的支出，加上阿哲還給小安的還款 `settlement('s1', …)`。
#[test]
fn the_first_ledger_with_its_repayment_is_settled() {
    let state = ledger(
        &OWNER_AND_MEMBER,
        vec![server_expense(1, "owner", &["owner", "member"])],
        vec![server_settlement(1, "member", "owner")],
    );
    let summary = summarize(&state);
    let nets: Vec<i64> = summary
        .balances
        .iter()
        .map(|balance| balance.net_cents)
        .collect();
    assert_eq!(nets, [0, 0]);
    assert_eq!(summary.total_cents, 90_000);
}

/// 來源：`tests/ledger.test.js` 的 `ledger write` ›
/// `boundary values are accepted: max amount, 1 cent, early purchase dates, 100 participants` 中
/// `summarizeLedger(env.ledger)` 的斷言：100 位旅伴（小安、阿哲，以及 `putState()` 加入的 98 位 `guest-{i}`
/// 「旅伴{i}」）與三筆邊界金額的支出，分攤的總和等於三筆金額的總和。
#[test]
fn boundary_amounts_shared_by_100_people_conserve_the_total() {
    // putState(…, s => { for (let i = 0; i < 98; i++) s.people.push({ id: `guest-${i}`, name: `旅伴${i}`, … }) })
    let guests: Vec<(String, String)> = (0..98)
        .map(|i| (format!("guest-{i}"), format!("旅伴{i}")))
        .collect();
    let people: Vec<(&str, &str)> = OWNER_AND_MEMBER
        .into_iter()
        .chain(guests.iter().map(|(id, name)| (id.as_str(), name.as_str())))
        .collect();
    let everyone: Vec<&str> = people.iter().map(|&(id, _)| id).collect();
    assert_eq!(everyone.len(), 100);

    let expenses = vec![
        Expense {
            amount_cents: 100_001,
            ..server_expense(0, "owner", &everyone)
        },
        Expense {
            amount_cents: 100_000_000,
            day: date("2026-10-01"),
            title: "x".repeat(100),
            note: "y".repeat(500),
            ..server_expense(1, "owner", &["owner"])
        },
        Expense {
            amount_cents: 1,
            day: date("2024-02-29"),
            category: ExpenseCategory::Lodging,
            ..server_expense(2, "owner", &["owner", "member"])
        },
    ];
    let summary = summarize(&ledger(&people, expenses, Vec::new()));
    let shares: i64 = summary
        .balances
        .iter()
        .map(|balance| balance.share_cents)
        .sum();
    assert_eq!(shares, 100_001 + 100_000_000 + 1);
}

/// 來源：`tests/ledger.test.js` 的 `ledger isolation and lifecycle` ›
/// `deleting a member account keeps their debt and name snapshot, never reassigning it` 中
/// `summarizeLedger(settled)` 的斷言：阿哲還給小安 NT$300 之後，阿哲的淨額為 0。現行此時阿哲的帳號已刪除，帳本以名字
/// 快照保留阿哲；第一版沒有刪除帳號，仍有帳目的旅伴也不能移除（需求 19.14），所以阿哲仍是旅伴，帳本的旅伴同樣是小安與
/// 阿哲。這個測試的其他斷言不移植（見檔頭）。
#[test]
fn repaying_the_whole_debt_settles_the_member() {
    let e1 = server_expense(1, "owner", &["owner", "member"]);
    let e2 = Expense {
        amount_cents: 30_000,
        ..server_expense(2, "member", &["member", "owner"])
    };
    let repay = Settlement {
        amount_cents: 30_000,
        ..server_settlement(1, "member", "owner")
    };
    let summary = summarize(&ledger(&OWNER_AND_MEMBER, vec![e1, e2], vec![repay]));
    assert_eq!(balance_of(&summary, "member").net_cents, 0);
}

// ── 現行資料的對應 ──

/// 現行的旅伴 id（字串）對應的 UUID：字串的位元組依序放在開頭，其餘補 0，所以 UUID 的順序與現行比較字串的順序相同
/// （見檔頭）。
fn person(name: &str) -> PersonId {
    let mut bytes = [0; 16];
    assert!(
        name.is_ascii() && name.len() <= bytes.len(),
        "{name:?} 不是最多 16 個位元組的 ASCII 字串"
    );
    bytes[..name.len()].copy_from_slice(name.as_bytes());
    PersonId(Uuid::from_bytes(bytes))
}

/// 以原案例陣列中的 id 建立的分攤旅伴。
fn participants(ids: &[&str]) -> BTreeSet<PersonId> {
    ids.iter().copied().map(person).collect()
}

fn date(text: &str) -> Date {
    lm_core::time::parse_date(text).unwrap_or_else(|| panic!("{text:?} 不是有效的日期"))
}

/// 現行 `tests/ledger.test.js` 的 `card`：「週末露營」，湖邊營地，2026-11-20 到 2026-11-22，封面 lake，規劃中。
fn card() -> TripCard {
    TripCard {
        id: id(Tag::Trip, 1),
        title: "週末露營".to_owned(),
        destination: "湖邊營地".to_owned(),
        start: date("2026-11-20"),
        end: date("2026-11-22"),
        description: String::new(),
        note: String::new(),
        cover: CoverKind::Lake,
        status: TripStatus::Planning,
        version: 0,
        caption: String::new(),
        headline: String::new(),
    }
}

/// 現行傳入 `summarizeLedger()` 的帳本 `{ people, expenses, settlements }`：Trip_Card 為 `card()` 的 Trip_State，依序
/// 逐一加入 `people`（旅伴 id 與名字）、`expenses` 與 `settlements`，每一列取得當時最大的 Ordinal 加 1。
fn ledger(
    people: &[(&str, &str)],
    expenses: Vec<Expense>,
    settlements: Vec<Settlement>,
) -> TripState {
    let mut state = TripState::new(card());
    for &(id, name) in people {
        let ordinal = state.max_ordinal() + 1;
        state.put(Row::Person(Person {
            id: person(id),
            name: name.to_owned(),
            role: String::new(),
            color: Color::Coral,
            bound: false,
            ordinal,
            version: 0,
        }));
    }
    for mut expense in expenses {
        expense.ordinal = state.max_ordinal() + 1;
        state.put(Row::Expense(expense));
    }
    for mut settlement in settlements {
        settlement.ordinal = state.max_ordinal() + 1;
        state.put(Row::Settlement(settlement));
    }
    state
}

/// 現行 `tests/expense-model.test.js` 的 `expense(id, amountCents, payerId, participantIds)`：支出 `e{n}`，日期
/// 2026-11-20，標題就是 id，分類「食材」，沒有備註與採買連結。Ordinal 由 `ledger()` 指定。
fn expense(n: u64, amount_cents: i64, payer: &str, participant_ids: &[&str]) -> Expense {
    Expense {
        id: id(Tag::Expense, n),
        day: date("2026-11-20"),
        title: format!("e{n}"),
        amount_cents,
        payer: person(payer),
        participants: participants(participant_ids),
        category: ExpenseCategory::Food,
        note: String::new(),
        shopping_item: None,
        ordinal: 0,
        version: 0,
    }
}

/// 現行 `tests/expense-model.test.js` 的 `settle(id, fromId, toId, amountCents)`：還款 `s{n}`，日期 2026-11-22，沒有
/// 備註。Ordinal 由 `ledger()` 指定。
fn settle(n: u64, from: &str, to: &str, amount_cents: i64) -> Settlement {
    Settlement {
        id: id(Tag::Settlement, n),
        day: date("2026-11-22"),
        from: person(from),
        to: person(to),
        amount_cents,
        note: String::new(),
        ordinal: 0,
        version: 0,
    }
}

/// 現行 `tests/ledger.test.js` 的 `expense(id, extra)` 加上付款人與分攤旅伴：支出 `e{n}`，預設日期 2026-11-20、標題
/// 「超市採買」、金額 90,000 分、分類「食材」，沒有備註與採買連結。`extra` 改寫的其他欄位以 `Expense { …, ..base }`
/// 寫出。
fn server_expense(n: u64, payer: &str, participant_ids: &[&str]) -> Expense {
    Expense {
        title: "超市採買".to_owned(),
        ..expense(n, 90_000, payer, participant_ids)
    }
}

/// 現行 `tests/ledger.test.js` 的 `settlement(id, extra)` 加上付款人與收款人：還款 `s{n}`，預設日期 2026-11-22、
/// 金額 45,000 分，沒有備註。
fn server_settlement(n: u64, from: &str, to: &str) -> Settlement {
    settle(n, from, to, 45_000)
}

/// 現行 `splitEvenly()` 的一項 `{ personId, amountCents }`。
fn share(person_id: &str, amount_cents: i64) -> Share {
    Share {
        person: person(person_id),
        amount_cents,
    }
}

/// 現行結餘的一項 `{ personId, paidCents, shareCents, sentCents, receivedCents, netCents }`；名字另以 `names()` 比對。
fn balance(
    person_id: &str,
    paid_cents: i64,
    share_cents: i64,
    sent_cents: i64,
    received_cents: i64,
    net_cents: i64,
) -> Balance {
    Balance {
        person: person(person_id),
        paid_cents,
        share_cents,
        sent_cents,
        received_cents,
        net_cents,
    }
}

/// 現行建議轉帳的一項 `{ fromId, toId, amountCents }`。
fn transfer(from: &str, to: &str, amount_cents: i64) -> Transfer {
    Transfer {
        from: person(from),
        to: person(to),
        amount_cents,
    }
}

/// 現行的 `s.balances.find(b => b.personId === id)`。
fn balance_of<'a>(summary: &'a LedgerSummary, person_id: &str) -> &'a Balance {
    let wanted = person(person_id);
    summary
        .balances
        .iter()
        .find(|balance| balance.person == wanted)
        .unwrap_or_else(|| panic!("結餘中沒有 {person_id}：{:?}", summary.balances))
}

/// 每一項結餘的旅伴在 Trip_State 中的名字，依結餘的順序；對應現行結餘的 `name`。
fn names<'a>(state: &'a TripState, summary: &LedgerSummary) -> Vec<&'a str> {
    summary
        .balances
        .iter()
        .map(|balance| match state.people.get(&balance.person) {
            Some(person) => person.name.as_str(),
            None => panic!("結餘的 {} 不是旅伴", balance.person),
        })
        .collect()
}
