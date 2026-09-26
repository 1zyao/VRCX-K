//! The hands → brain hello: who this node is, and what environment it has.
//!
//! # Why this exists (and why a per-field "source" tag would not do)
//!
//! The stdio channel is a pure RPC bus today: the brain announces itself
//! (`ready`, carrying the BRAIN's cwd/execPath/runtime), and the shell says
//! nothing. So the brain cannot tell which machine — or which process — it is
//! talking to, and every fact it reads from the shell arrives with no owner.
//!
//! The tempting fix is to tag each payload (`{ source: "hands", ... }`). That is
//! a **per-field** discipline: it has to be remembered on every field, and one
//! omission produces a value that looks local but came from elsewhere. That is
//! the same failure mode as `host/src/capability.ts`'s note that `fiber.name` is
//! not an identity — a name that *looks* like a key but is not one.
//!
//! Announcing identity **once, at handshake**, is structural instead: the channel
//! is bound to node N, so every later fact on it belongs to N by construction.
//! There is nothing to forget.
//!
//! # Why the environment travels here rather than in a query route
//!
//! Same reason, from the other side. `~` and `%VAR%` expansion needs the shell's
//! own home and environment. A dedicated route (`os.env`) would answer that, but
//! the answer would be a second, unrelated call whose result is indistinguishable
//! from the brain's own environment — the exact confusion this module prevents.
//! Carrying it in the hello binds it to the node at the only moment where the
//! binding is unambiguous.
//!
//! # What is deliberately NOT here
//!
//! - **A stable machine id.** There is no persistence in the shell yet, so any id
//!   generated here would change every launch. A per-launch id is still worth
//!   sending (it makes "did the shell restart?" answerable), but it must not be
//!   presented as a durable device identity — that is `#13`'s problem, and it
//!   needs per-device credentials, not a random string.
//! - **Live/slow-changing values.** The hello is sent once per shell process; a
//!   field that changes minute-to-minute would be read as a constant. Measured
//!   precedent: `host-ready.schema.json` states the same rule for `capacity`.

use serde_json::{json, Value};
use std::sync::Arc;

use crate::kkrpc_peer::Peer;

/// Version of the hello shape.
///
/// Mirrors `HOST_READY_SCHEMA_VERSION`'s role on the other channel: the peer that
/// does not recognise this must refuse rather than guess at fields. The shell is
/// the more likely of the two to be upgraded first, so the brain is the side that
/// most needs a number to check.
pub const HANDS_HELLO_SCHEMA_VERSION: u16 = 1;

/// Collect the environment as an explicit key/value map.
///
/// `std::env::vars()` yields `String`, and a non-UTF-8 value is SKIPPED rather
/// than lossily converted: a mangled path is worse than an absent one, because it
/// looks usable. `vars_os` + `to_str` is what makes that choice possible.
fn environment() -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in std::env::vars_os() {
        let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
            continue;
        };
        // A credential in the environment is not made safe by being on a pipe the
        // brain already controls — but it IS worth not duplicating into logs and
        // crash reports, which is where this payload ends up. Recorded as present
        // with no value, so "the variable exists" stays answerable without the
        // secret travelling further than it already has.
        if looks_secret(key) {
            map.insert(key.to_string(), json!("<redacted>"));
            continue;
        }
        map.insert(key.to_string(), json!(value));
    }
    Value::Object(map)
}

/// The characters that separate word-tokens inside an environment variable name.
///
/// ⚠ Defined ONCE and used by both matching rules in [`looks_secret`]. They must
/// agree: rule 1 joins exactly what rule 2 splits, so if the two lists ever
/// disagree — one strips `:` and the other does not — a name can be normalised
/// into a marker that its own tokens never reveal. Sharing one list makes that
/// impossible, and `clippy::manual_pattern_char_comparison` is satisfied by
/// passing the slice rather than a closure.
const NAME_SEPARATORS: [char; 4] = ['_', '-', '.', ' '];

/// Whether a variable name suggests a credential.
///
/// Deliberately a NAME heuristic and not a value scan: this cannot be perfect,
/// and pretending otherwise would be worse than admitting the limit. It is a
/// redaction aid for logs, NOT a security boundary — the brain shares this
/// environment already when both run on one machine.
///
/// # ⚠ Why matching is done in two different ways
///
/// The first version was one rule — `upper.contains(marker)` over a list holding
/// `APIKEY` and `PRIVATE_KEY` — and that single rule was wrong in **both**
/// directions at once:
///
///   **It missed the most common spelling in the wild.** `OPENAI_API_KEY` does
///   not contain `APIKEY`, because the underscore breaks the substring. The most
///   recognizable API-key name there is travelled with its value intact. The
///   mirror case proves the fragility: `AWS_PRIVATE_KEY` matched only because the
///   marker happened to be spelled with the same single separator, so
///   `AWS_PRIVATEKEY` would have missed instead. One marker list was encoding one
///   separator convention as though it were the rule.
///
///   **Making `contains` more permissive would break it the other way.** Adding
///   the abbreviations the reviewer asked for (`PWD`, `PAT`, `PASS`, `SESSION`)
///   as plain substrings is not an option, because `PAT` as a substring matches
///   **`PATH`** — the single most load-bearing variable in the environment would
///   be redacted — and with `PWD`/`PASS` the same trick hits `PWDLASTSET` and
///   `BYPASS_PROXY`. Substring matching cannot tell a word from a coincidence
///   inside a word.
///
/// So two rules, each chosen for the shape of its markers:
///
///   1. **Long, word-shaped markers match anywhere**, on a form with separators
///      stripped — `API_KEY`, `APIKEY`, `api-key` and `Api Key` all collapse to
///      `APIKEY`. These are long enough that an accidental substring is not
///      realistic, and stripping is what lets one marker cover every separator
///      convention. The markers are spelled in the **stripped** alphabet
///      (`PRIVATEKEY`, not `PRIVATE_KEY`); a marker containing a separator would
///      be unmatchable, which is precisely the bug being fixed.
///
///   2. **Short abbreviations must be a whole token**, where a token is what
///      lies between separators. `GITHUB_PAT` has the token `PAT`; `PATH` has the
///      token `PATH`. That distinction is the entire reason `PATH` survives.
///      Requiring only *suffix* equality would be stricter but would miss
///      `MY_PAT_VALUE`; whole-token equality covers it while still refusing to
///      find `PAT` inside `PATH`.
///
/// # What is still not covered (⚠ the honest boundary)
///
///   - A marker-free name is invisible to this: `OPENAI_KEY`, `DOCKER_CONFIG`,
///     `NPM_CONFIG__AUTH` is covered by the `AUTH` token but a bespoke
///     `SOMETHING_IMPORTANT` is not. A NAME heuristic cannot recover intent from
///     a name, and pretending otherwise is the failure this comment exists to
///     prevent.
///   - A short abbreviation glued into a word with no separator is invisible:
///     `MYPATVALUE` is not redacted. That is deliberate — the alternative is
///     redacting `PATH` — and it is the residual gap this design accepts.
///   - Both rules produce FALSE POSITIVES, which is the safe direction:
///     `TOKENIZER_PATH` (contains `TOKEN`) and `SSH_AUTH_SOCK` (token `AUTH`)
///     are redacted although neither is a secret. That costs a useless
///     `<redacted>` in a log; the opposite error leaks a credential.
///   - Names are compared ASCII-case-insensitively only, so a name spelled with
///     non-ASCII letters matches nothing. Env var names are effectively ASCII on
///     every platform we target.
fn looks_secret(key: &str) -> bool {
    // Rule 1's input: separators removed, then uppercased. `+` is deliberately
    // NOT stripped — `C++` and `SHA256` must not be restructured into a new word
    // that happens to contain a marker.
    let normalised: String = key
        .chars()
        .filter(|c| !NAME_SEPARATORS.contains(c))
        .collect::<String>()
        .to_ascii_uppercase();

    // ⚠ Spelled in the NORMALISED alphabet. Writing `PRIVATE_KEY` here would
    // make it unmatchable, since the input has had its underscores removed.
    const LONG_MARKERS: [&str; 14] = [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "PRIVATEKEY",
        "APIKEY",
        "ACCESSKEY",
        "SECRETKEY",
        "BEARER",
        "SIGNATURE",
        "CERTIFICATE",
        "ENCRYPTIONKEY",
        "SALT",
    ];
    if LONG_MARKERS
        .iter()
        .any(|marker| normalised.contains(marker))
    {
        return true;
    }

    // Rule 2: whole-token equality on the ORIGINAL name, so the separators that
    // bound a word are still available. Redacting all of `PAT`/`PATH` alike is
    // the bug this rule exists to avoid.
    //
    // ⚠ There is deliberately no bare `KEY` token here. `AWS_ACCESS_KEY_ID` is
    // the name the reviewer asked for and it is already covered by the `ACCESSKEY`
    // long marker, while a bare `KEY` token would redact `PUBLIC_KEY` and
    // `SSH_KEY_PATH` — neither of which is a secret — and buy nothing.
    const SHORT_MARKERS: [&str; 8] = [
        "PWD",     // Windows/Unix shells; `MYSQL_PWD`, `PGPASSWORD` is rule 1
        "PAT",     // GitHub/Azure personal access token
        "PASS",    // `DB_PASS`
        "SESSION", // session ids and cookies are bearer credentials
        "AUTH",    // `NPM_CONFIG__AUTH`
        "OTP", "PIN", "CERT", // `CLIENT_CERT`
    ];
    key.split(NAME_SEPARATORS).any(|token| {
        let token = token.to_ascii_uppercase();
        !token.is_empty() && SHORT_MARKERS.contains(&token.as_str())
    })
}

/// Build the hello payload.
///
/// Pure, so it is testable without a peer or a real environment.
pub fn hello_payload() -> Value {
    // `.` rather than the process's startup directory when the cwd is gone: on
    // Windows a deleted cwd makes `current_dir()` fail, and a failed cwd must not
    // sink the whole handshake. The reason is reported instead, separately, so a
    // consumer can tell "no cwd" from "cwd happened to be empty".
    let (cwd, cwd_error) = match std::env::current_dir() {
        Ok(path) => (path.to_string_lossy().to_string(), Value::Null),
        Err(error) => (String::new(), json!(error.to_string())),
    };

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    json!({
        "schemaVersion": HANDS_HELLO_SCHEMA_VERSION,
        "node": {
            // Per-launch. See the module note: NOT a durable device identity.
            "launchId": launch_id(),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
            // The version of THIS shell build, so the brain can tell "the hands
            // were upgraded" from "the hands are misbehaving".
            "shellVersion": env!("CARGO_PKG_VERSION"),
        },
        "cwd": cwd,
        "cwdError": cwd_error,
        "home": home,
        "env": environment(),
    })
}

/// A per-launch random id.
///
/// Built from the process start time and pid rather than pulling in a random
/// source: it only has to distinguish two launches of this shell on this machine,
/// and both inputs are already available. Uniqueness ACROSS machines is not
/// claimed and not needed — the field is named `launchId`, and `#13` owns the
/// durable identity problem.
fn launch_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{:x}", std::process::id())
}

/// Send the hello to the brain.
///
/// Best-effort by design: failing to announce identity must not stop the shell
/// from starting. The failure is reported to stderr so it is not silent.
pub fn send_hello(peer: &Arc<Peer>) {
    match peer.notify("hands.hello", vec![hello_payload()]) {
        Ok(()) => {}
        Err(error) => eprintln!("[shell] hands hello failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_carries_the_schema_version_and_node_identity() {
        // Without these two the brain cannot tell a version skew from a bug, and
        // cannot tell one node from another — the two things the hello is FOR.
        let payload = hello_payload();
        assert_eq!(payload["schemaVersion"], json!(HANDS_HELLO_SCHEMA_VERSION));
        assert_eq!(payload["node"]["platform"], json!(std::env::consts::OS));
        assert_eq!(payload["node"]["arch"], json!(std::env::consts::ARCH));
        assert!(
            payload["node"]["launchId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "a launch id is required even if it is not durable"
        );
    }

    #[test]
    fn the_payload_carries_the_environment_the_brain_would_otherwise_guess() {
        let payload = hello_payload();
        let env = payload["env"].as_object().expect("env object");
        assert!(
            !env.is_empty(),
            "an empty environment would make the field useless"
        );
    }

    #[test]
    fn the_environment_has_no_null_values() {
        // Every value must be a JSON string. A null would reach the brain as
        // "present but unknown", which is indistinguishable from a variable that
        // is genuinely unset — and the map's whole point is that presence means
        // presence.
        let payload = hello_payload();
        for (key, value) in payload["env"].as_object().expect("env") {
            assert!(
                value.is_string(),
                "{key} is not a string: {value} (non-UTF-8 values must be skipped)"
            );
        }
    }

    #[test]
    fn secret_shaped_names_are_redacted_by_name() {
        // This is the falsifiable part of the redaction: a name that matches must
        // NOT carry its value. (The heuristic's coverage is deliberately partial —
        // see `looks_secret` — but a match must always redact.)
        assert!(looks_secret("GH_TOKEN"));
        assert!(looks_secret("my_secret_thing"));
        assert!(looks_secret("NPM_PASSWORD"));
        assert!(looks_secret("AWS_PRIVATE_KEY"));
        assert!(!looks_secret("PATH"));
        assert!(!looks_secret("HOME"));

        // End to end: a planted variable must arrive redacted.
        // Not `unsafe`: this crate is edition 2021, where `set_var` is safe.
        std::env::set_var("VRCXK_TEST_SECRET_TOKEN", "super-secret-value");
        let payload = hello_payload();
        std::env::remove_var("VRCXK_TEST_SECRET_TOKEN");
        assert_eq!(
            payload["env"]["VRCXK_TEST_SECRET_TOKEN"],
            json!("<redacted>"),
            "a token-shaped name must not carry its value"
        );
    }

    /// The exact name the reviewer used to show the old check was broken.
    ///
    /// `OPENAI_API_KEY` does not contain the substring `APIKEY`, so the old
    /// `contains` rule let the most common API-key spelling through with its
    /// value. This test fails against that implementation and passes against
    /// separator-stripping, which is what makes it a regression guard rather
    /// than a restatement.
    #[test]
    fn an_underscored_api_key_is_redacted_like_the_glued_spelling() {
        // The pair matters more than either half: if these two ever disagree,
        // the separator normalisation has been broken.
        assert!(looks_secret("OPENAI_API_KEY"));
        assert!(looks_secret("OPENAI_APIKEY"));
        // And the same convention in other separators, since the original bug
        // was one rule silently encoding one separator convention.
        assert!(looks_secret("openai-api-key"));
        assert!(looks_secret("Openai.Api.Key"));
        assert!(looks_secret("Openai Api Key"));
    }

    /// Each short abbreviation the reviewer named as entirely unmatched.
    #[test]
    fn the_short_abbreviations_the_reviewer_flagged_are_now_covered() {
        for name in [
            "MYSQL_PWD",
            "DB_PWD",
            "GITHUB_PAT",
            "AZURE_DEVOPS_PAT",
            "DB_PASS",
            "REDIS_PASS",
            "SESSION_ID",
            "PHP_SESSION",
        ] {
            assert!(looks_secret(name), "{name} must be redacted");
        }
    }

    /// The AWS pair: `AWS_ACCESS_KEY_ID` was unmatched entirely, and
    /// `AWS_SECRET_ACCESS_KEY` only by luck of the `SECRET` substring.
    #[test]
    fn the_aws_credential_names_are_covered() {
        assert!(looks_secret("AWS_ACCESS_KEY_ID"));
        assert!(looks_secret("AWS_SECRET_ACCESS_KEY"));
        // `ACCESSKEY` is a LONG marker, so it matches across separators.
        assert!(looks_secret("aws-access-key-id"));
        assert!(looks_secret("AWS_ACCESSKEY_ID"));
    }

    /// ⚠ The counterweight to the test above, and the reason `PAT`/`KEY` could
    /// not simply be added as substrings.
    ///
    /// `PATH` contains `PAT`. A naive widening of the marker list — the obvious
    /// way to "cover `*_PAT`" — would have redacted `PATH`, i.e. destroyed the
    /// most useful variable in the payload to protect one of the least common.
    /// `KEY` as a substring would likewise hit `KEYBOARD_LAYOUT`. This test pins
    /// the whole-token rule that keeps them apart.
    #[test]
    fn widening_the_list_did_not_swallow_path_or_other_ordinary_names() {
        assert!(
            !looks_secret("PATH"),
            "PATH contains PAT but is not a token"
        );
        assert!(!looks_secret("Path"));
        assert!(!looks_secret("PATHEXT"));
        assert!(!looks_secret("KEYBOARD_LAYOUT"));
        assert!(!looks_secret("PUBLIC_KEY_PATH"));
        // Real, non-secret variables that a too-eager rule would eat.
        assert!(!looks_secret("HOME"));
        assert!(!looks_secret("USERPROFILE"));
        assert!(!looks_secret("TEMP"));
        assert!(!looks_secret("COMPUTERNAME"));
        assert!(!looks_secret("PROCESSOR_ARCHITECTURE"));
    }

    /// The whole-token rule accepts the abbreviation at any separator boundary,
    /// not only as a suffix — `MY_PAT_VALUE` is a real shape.
    #[test]
    fn a_short_abbreviation_is_matched_as_a_whole_token_anywhere_in_the_name() {
        assert!(looks_secret("MY_PAT_VALUE"));
        assert!(looks_secret("pat"));
        assert!(looks_secret("MY-PWD-VALUE"));
        // Whole-token means `MYPATVALUE` does NOT match: there is no separator to
        // bound the token, and the residual gap is documented on `looks_secret`
        // rather than papered over by a substring rule that would eat `PATH`.
        assert!(!looks_secret("MYPATVALUE"));
    }

    /// A false positive only costs a `<redacted>` in a log, so the design accepts
    /// them — but they should be *stated*, not discovered later as a surprise.
    #[test]
    fn false_positives_are_the_safe_direction_and_are_expected() {
        // Neither of these is a secret; both are redacted on purpose.
        assert!(looks_secret("TOKENIZER_PATH"));
        assert!(looks_secret("SSH_AUTH_SOCK"));
    }

    /// End to end for the reviewer's headline case: the planted value must not
    /// survive into the payload, which is what actually crosses the wire.
    #[test]
    fn a_planted_underscored_api_key_never_reaches_the_payload() {
        std::env::set_var("VRCXK_TEST_OPENAI_API_KEY", "sk-do-not-leak-me");
        std::env::set_var("VRCXK_TEST_AWS_ACCESS_KEY_ID", "AKIA-do-not-leak-me");
        let payload = hello_payload();
        std::env::remove_var("VRCXK_TEST_OPENAI_API_KEY");
        std::env::remove_var("VRCXK_TEST_AWS_ACCESS_KEY_ID");
        assert_eq!(
            payload["env"]["VRCXK_TEST_OPENAI_API_KEY"],
            json!("<redacted>")
        );
        assert_eq!(
            payload["env"]["VRCXK_TEST_AWS_ACCESS_KEY_ID"],
            json!("<redacted>")
        );
        // ⚠ And the presence of the key is still answerable: the fix must not
        // have replaced redaction with omission.
        assert_eq!(
            payload["env"]["VRCXK_TEST_OPENAI_API_KEY"],
            json!("<redacted>"),
            "the variable must be present-but-redacted, not dropped"
        );
    }

    #[test]
    fn cwd_and_home_are_strings_even_when_unavailable() {
        // A consumer must be able to read these unconditionally; absence is
        // signalled by an empty string plus `cwdError`, not by a missing key.
        let payload = hello_payload();
        assert!(payload["cwd"].is_string());
        assert!(payload["home"].is_string());
    }
}
