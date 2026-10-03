use crate::validate_secret_key;

#[derive(serde::Deserialize)]
struct SecretEvent {
    r#type: String,
    key: String,
    #[serde(rename = "serverId")]
    server_id: String,
    value: Option<String>,
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

// Credentials can themselves be JSON strings. Owned strings allow serde to
// decode their escapes instead of requiring a slice of the original input.
pub fn persist_runtime_secret(line: &str) -> String {
    let result = (|| -> Result<String, String> {
        // Serde errors may include credential contents. Report only a safe
        // message, and never forward the original secret event on failure.
        let event: SecretEvent = serde_json::from_str(line)
            .map_err(|_| "Invalid MCP OAuth credential event".to_string())?;
        let token = match event.r#type.as_str() {
            "mcp.oauth.invalidated" => None,
            "mcp.oauth.credential" => Some(
                event
                    .value
                    .as_deref()
                    .ok_or("Missing MCP OAuth credential")?,
            ),
            "mcp.oauth.token" => Some(
                event
                    .access_token
                    .as_deref()
                    .ok_or("Missing MCP OAuth token")?,
            ),
            _ => return Err("Invalid MCP OAuth credential event".into()),
        };
        validate_secret_key(&event.key)?;
        #[cfg(windows)]
        {
            if let Some(token) = token {
                crate::creds::set(&event.key, token)?;
            } else if crate::creds::get(&event.key)?.is_some() {
                crate::creds::delete(&event.key)?;
            }
            Ok(serde_json::json!({
                "type": if token.is_some() { "mcp.oauth.saved" } else { "mcp.oauth.invalidated" },
                "serverId": event.server_id,
                "key": event.key,
            })
            .to_string())
        }
        #[cfg(not(windows))]
        {
            let _ = token;
            Err("secrets only supported on Windows".into())
        }
    })();
    result.unwrap_or_else(|error| {
        serde_json::json!({ "type": "error", "message": error }).to_string()
    })
}

#[cfg(test)]
#[path = "credential_bridge_tests.rs"]
mod tests;
