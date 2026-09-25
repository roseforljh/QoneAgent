use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

const PREFIX: &str = "QoneAgent:";
const MANIFEST_PREFIX: &str = "\u{1f}QoneAgentChunksV1:";
const MAX_BLOB_BYTES: usize = 2560;
const CHUNK_UNITS: usize = 1200;
const MAX_CHUNKS: usize = 128;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn write_raw(key: &str, value: &str) -> Result<(), String> {
    let target = wide(&format!("{PREFIX}{key}"));
    let mut blob: Vec<u16> = value.encode_utf16().collect();
    if blob.len() * 2 > MAX_BLOB_BYTES {
        return Err("credential exceeds Windows Credential Manager limit".into());
    }
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_ptr() as *mut _),
        CredentialBlobSize: (blob.len() * 2) as u32,
        CredentialBlob: blob.as_mut_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0).map_err(|error| format!("CredWrite failed: {error}")) }
}

fn read_raw(key: &str) -> Result<Option<String>, String> {
    let target = wide(&format!("{PREFIX}{key}"));
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
        match CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut pointer,
        ) {
            Ok(()) => {
                let credential = &*pointer;
                let units = if credential.CredentialBlobSize == 0 {
                    &[][..]
                } else {
                    std::slice::from_raw_parts(
                        credential.CredentialBlob as *const u16,
                        credential.CredentialBlobSize as usize / 2,
                    )
                };
                let value = String::from_utf16_lossy(units);
                CredFree(pointer as *const _);
                Ok(Some(value))
            }
            Err(error) if error.code().0 as u32 == 0x80070490 => Ok(None),
            Err(error) => Err(format!("CredRead failed: {error}")),
        }
    }
}

fn delete_raw(key: &str) -> Result<(), String> {
    let target = wide(&format!("{PREFIX}{key}"));
    unsafe {
        CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None)
            .map_err(|error| format!("CredDelete failed: {error}"))
    }
}

fn chunks(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut chunk = String::new();
    let mut units = 0;
    for character in value.chars() {
        let size = character.len_utf16();
        if units + size > CHUNK_UNITS {
            result.push(std::mem::take(&mut chunk));
            units = 0;
        }
        chunk.push(character);
        units += size;
    }
    if !chunk.is_empty() {
        result.push(chunk);
    }
    result
}

fn manifest(value: &str) -> Result<Option<(&str, usize)>, String> {
    let Some(rest) = value.strip_prefix(MANIFEST_PREFIX) else {
        return Ok(None);
    };
    let (generation, count) = rest.split_once(':').ok_or("invalid credential manifest")?;
    let count = count
        .parse::<usize>()
        .map_err(|_| "invalid credential manifest")?;
    if generation.is_empty()
        || !generation.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !(1..=MAX_CHUNKS).contains(&count)
    {
        return Err("invalid credential manifest".into());
    }
    Ok(Some((generation, count)))
}

fn chunk_key(key: &str, generation: &str, index: usize) -> String {
    format!("{key}.chunk.{generation}.{index}")
}

fn delete_chunks(key: &str, generation: &str, count: usize) {
    for index in 0..count {
        let _ = delete_raw(&chunk_key(key, generation, index));
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let previous = read_raw(key)?.and_then(|value| {
        manifest(&value)
            .ok()
            .flatten()
            .map(|(generation, count)| (generation.to_owned(), count))
    });
    if value.encode_utf16().count() * 2 <= MAX_BLOB_BYTES {
        write_raw(key, value)?;
    } else {
        let parts = chunks(value);
        if parts.len() > MAX_CHUNKS {
            return Err("secret value is too large".into());
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let generation = format!(
            "{nonce:x}{:x}{:x}",
            std::process::id(),
            NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
        );
        for (index, part) in parts.iter().enumerate() {
            if let Err(error) = write_raw(&chunk_key(key, &generation, index), part) {
                delete_chunks(key, &generation, index);
                return Err(error);
            }
        }
        if let Err(error) = write_raw(
            key,
            &format!("{MANIFEST_PREFIX}{generation}:{}", parts.len()),
        ) {
            delete_chunks(key, &generation, parts.len());
            return Err(error);
        }
    }
    if let Some((generation, count)) = previous {
        delete_chunks(key, &generation, count);
    }
    Ok(())
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    let Some(value) = read_raw(key)? else {
        return Ok(None);
    };
    let Some((generation, count)) = manifest(&value)? else {
        return Ok(Some(value));
    };
    let mut combined = String::new();
    for index in 0..count {
        let part =
            read_raw(&chunk_key(key, generation, index))?.ok_or("credential chunk is missing")?;
        combined.push_str(&part);
    }
    Ok(Some(combined))
}

pub fn delete(key: &str) -> Result<(), String> {
    let previous = read_raw(key)?.and_then(|value| {
        manifest(&value)
            .ok()
            .flatten()
            .map(|(generation, count)| (generation.to_owned(), count))
    });
    delete_raw(key)?;
    if let Some((generation, count)) = previous {
        delete_chunks(key, &generation, count);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{chunks, delete, get, manifest, set, MANIFEST_PREFIX, MAX_BLOB_BYTES};

    #[test]
    fn splits_large_unicode_secrets_without_losing_characters() {
        let value = "🔐令牌".repeat(600);
        let parts = chunks(&value);
        assert!(parts.len() > 1);
        assert!(parts
            .iter()
            .all(|part| part.encode_utf16().count() * 2 <= MAX_BLOB_BYTES));
        assert_eq!(parts.concat(), value);
    }

    #[test]
    fn parses_manifest_and_rejects_invalid_counts() {
        assert_eq!(manifest("legacy-token").unwrap(), None);
        assert_eq!(
            manifest(&format!("{MANIFEST_PREFIX}abcd:3")).unwrap(),
            Some(("abcd", 3))
        );
        assert!(manifest(&format!("{MANIFEST_PREFIX}abcd:129")).is_err());
    }

    #[test]
    fn stores_and_restores_large_secret_in_credential_manager() {
        let key = format!("test.large-secret.{}", std::process::id());
        let value = "🔐cloudflare-token".repeat(400);
        set(&key, &value).unwrap();
        assert_eq!(get(&key).unwrap(), Some(value));
        delete(&key).unwrap();
        assert_eq!(get(&key).unwrap(), None);
    }
}
