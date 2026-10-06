use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires: Option<f64>,
    #[serde(rename = "httpOnly")]
    pub http_only: bool,
    pub secure: bool,
    #[serde(rename = "sameSite")]
    pub same_site: String,
    pub session: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthFile {
    pub version: u8,
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(default)]
    pub cookies: Vec<AuthCookie>,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
}

fn validate_app_id(app_id: &str) -> Result<(), String> {
    if app_id.is_empty()
        || app_id.len() > 64
        || !app_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("invalid app id".into());
    }
    Ok(())
}

fn path(app_id: &str) -> Result<PathBuf, String> {
    validate_app_id(app_id)?;
    Ok(crate::data_paths::auth()?.join(format!("{app_id}.json")))
}

fn invalid_cookie_field(cookie: &AuthCookie) -> Option<&'static str> {
    if cookie.name.is_empty() {
        Some("name is empty")
    } else if cookie.name.len() > 256 {
        Some("name is too long")
    } else if cookie.value.len() > 65_536 {
        Some("value is too long")
    } else if cookie.domain.is_empty() {
        Some("domain is empty")
    } else if cookie.domain.len() > 512 {
        Some("domain is too long")
    } else if cookie.path.is_empty() {
        Some("path is empty")
    } else if cookie.path.len() > 4096 {
        Some("path is too long")
    } else {
        None
    }
}

pub fn save(app_id: String, cookies: Vec<AuthCookie>) -> Result<AuthFile, String> {
    validate_app_id(&app_id)?;
    if cookies.is_empty() {
        return Err("no cookies found; finish signing in first".into());
    }
    if let Some((index, reason)) = cookies
        .iter()
        .enumerate()
        .find_map(|(index, cookie)| invalid_cookie_field(cookie).map(|reason| (index, reason)))
    {
        return Err(format!("invalid cookie data at index {index}: {reason}"));
    }
    let target = path(&app_id)?;
    let saved_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let file = AuthFile {
        version: 2,
        app_id,
        cookies,
        saved_at,
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
    let temporary = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| {
        let mut handle = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        handle
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        handle.sync_all().map_err(|error| error.to_string())?;
        match fs::rename(&temporary, &target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let backup = target.with_extension(format!("json.{}.bak", std::process::id()));
                fs::rename(&target, &backup).map_err(|rename_error| rename_error.to_string())?;
                match fs::rename(&temporary, &target) {
                    Ok(()) => {
                        let _ = fs::remove_file(backup);
                        Ok(())
                    }
                    Err(rename_error) => {
                        let _ = fs::rename(&backup, &target);
                        Err(rename_error.to_string())
                    }
                }
            }
            Err(error) => Err(error.to_string()),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|_| file)
}

pub fn get(app_id: String) -> Result<Option<AuthFile>, String> {
    let target = path(&app_id)?;
    match fs::read(&target) {
        Ok(bytes) => {
            let file: AuthFile = serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid auth file: {error}"))?;
            Ok((!file.cookies.is_empty()).then_some(file))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete(app_id: String) -> Result<(), String> {
    let target = path(&app_id)?;
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
