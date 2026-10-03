use super::persist_runtime_secret;
use serde_json::{json, Value};

fn assert_safe_error(line: &str) {
    let emitted = persist_runtime_secret(line);
    let event: Value = serde_json::from_str(&emitted).unwrap();
    assert_eq!(event["type"], "error");
    assert!(event["message"].is_string());
    assert_eq!(event.as_object().unwrap().len(), 2);
    assert!(!emitted.contains("private-test-secret"));
}

#[test]
fn rejects_malformed_events_without_forwarding_secrets() {
    for line in [
        r#"{"type":"mcp.oauth.token","accessToken":"private-test-secret""#,
        r#"{"type":"mcp.oauth.token","key":"mcp.oauth:test","serverId":"test","accessToken":["private-test-secret"]}"#,
        r#"{"type":"mcp.oauth.token","key":"mcp.oauth:test","serverId":"test","value":"private-test-secret"}"#,
        r#"{"type":"mcp.oauth.credential","key":"mcp.oauth:test","serverId":"test","accessToken":"private-test-secret"}"#,
        r#"{"type":"mcp.oauth.token","key":"mcp.oauth:test","accessToken":"private-test-secret"}"#,
        r#"{"type":"mcp.oauth.token","serverId":"test","accessToken":"private-test-secret"}"#,
        r#"{"type":"mcp.oauth.token","key":"invalid key","serverId":"test","accessToken":"private-test-secret"}"#,
        r#"{"type":"unexpected","key":"mcp.oauth:test","serverId":"test","accessToken":"private-test-secret"}"#,
    ] {
        assert_safe_error(line);
    }
}

#[test]
fn recognizes_escaped_event_types_before_interception() {
    let line = r#"{"type":"mcp.oauth.\u0074oken","key":"mcp.oauth:test","serverId":"test","accessToken":["private-test-secret"]}"#;
    assert_eq!(
        crate::runtime_event_type(line).as_deref(),
        Some("mcp.oauth.token")
    );
    assert_safe_error(line);
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::creds;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_KEY: AtomicU64 = AtomicU64::new(0);

    struct TestCredential(String);

    impl TestCredential {
        fn new() -> Self {
            Self(format!(
                "mcp.oauth:bridge-test.{}.{:x}.{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_KEY.fetch_add(1, Ordering::Relaxed),
            ))
        }

        fn send(&self, event: Value) -> Value {
            let mut event = event;
            event["key"] = json!(self.0);
            event["serverId"] = json!("bridge-test");
            serde_json::from_str(&persist_runtime_secret(&event.to_string())).unwrap()
        }

        fn assert_saved(&self, event: Value, expected: &str) {
            assert_eq!(
                self.send(event),
                json!({
                    "type": "mcp.oauth.saved", "serverId": "bridge-test", "key": self.0,
                })
            );
            assert_eq!(creds::get(&self.0).unwrap().as_deref(), Some(expected));
        }
    }

    impl Drop for TestCredential {
        fn drop(&mut self) {
            let _ = creds::delete(&self.0);
        }
    }

    #[test]
    fn saves_plain_and_escaped_tokens() {
        let key = TestCredential::new();
        for token in ["plain-test-token", "private-test-secret\"\\\n\r\t🔐令牌"] {
            key.assert_saved(
                json!({ "type": "mcp.oauth.token", "accessToken": token }),
                token,
            );
        }
    }

    #[test]
    fn persists_login_and_rotated_refresh_pairs() {
        let key = TestCredential::new();
        for (request_id, access, refresh) in [
            ("oauth-callback", "test-access", "test-refresh"),
            (
                "oauth-refresh",
                "test-access-rotated",
                "test-refresh-rotated",
            ),
        ] {
            let token = json!({ "accessToken": access, "refreshToken": refresh }).to_string();
            key.assert_saved(
                json!({
                    "type": "mcp.oauth.token", "requestId": request_id, "accessToken": token,
                }),
                &token,
            );
        }
    }

    #[test]
    fn saves_hosted_oauth_client_and_tokens() {
        for value in [
            json!({ "client_id": "test-client", "client_secret": "private-test-secret" }).to_string(),
            json!({ "access_token": "private-test-secret", "refresh_token": "test-refresh", "token_type": "Bearer" }).to_string(),
        ] {
            let key = TestCredential::new();
            key.assert_saved(json!({ "type": "mcp.oauth.credential", "value": value }), &value);
        }
    }

    #[test]
    fn saves_large_json_credentials_without_truncation() {
        let key = TestCredential::new();
        let token = json!({ "accessToken": "🔐令牌".repeat(600), "refreshToken": "test-refresh" })
            .to_string();
        key.assert_saved(
            json!({ "type": "mcp.oauth.token", "accessToken": token }),
            &token,
        );
    }

    #[test]
    fn invalidation_deletes_credentials_and_only_emits_metadata() {
        let key = TestCredential::new();
        creds::set(&key.0, "private-test-secret").unwrap();
        for _ in 0..2 {
            assert_eq!(
                key.send(json!({
                    "type": "mcp.oauth.invalidated", "accessToken": "private-test-secret",
                })),
                json!({
                    "type": "mcp.oauth.invalidated", "serverId": "bridge-test", "key": key.0,
                })
            );
            assert_eq!(creds::get(&key.0).unwrap(), None);
        }
    }

    #[test]
    fn rejected_update_preserves_the_previous_credential() {
        let key = TestCredential::new();
        creds::set(&key.0, "previous-test-token").unwrap();
        let event = key.send(json!({
            "type": "mcp.oauth.token", "accessToken": ["private-test-secret"],
        }));
        assert_eq!(event["type"], "error");
        assert!(!event.to_string().contains("private-test-secret"));
        assert_eq!(
            creds::get(&key.0).unwrap().as_deref(),
            Some("previous-test-token")
        );
    }

    #[test]
    fn storage_failure_keeps_previous_credentials_and_does_not_forward_secrets() {
        let key = TestCredential::new();
        creds::set(&key.0, "previous-test-token").unwrap();
        // Exceed the credential store's chunk capacity to exercise a real
        // write failure without depending on Windows permissions or mocks.
        let event = key.send(json!({
            "type": "mcp.oauth.token", "accessToken": "private-test-secret".repeat(10_000),
        }));
        assert_eq!(event["type"], "error");
        assert_eq!(event["message"], "secret value is too large");
        assert_eq!(event.as_object().unwrap().len(), 2);
        assert!(!event.to_string().contains("private-test-secret"));
        assert_eq!(
            creds::get(&key.0).unwrap().as_deref(),
            Some("previous-test-token")
        );
    }
}
