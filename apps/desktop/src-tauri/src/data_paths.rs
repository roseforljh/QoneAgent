use std::path::PathBuf;

pub fn root() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("QONE_DATA_DIR") {
        let configured = configured.to_string_lossy();
        let configured = configured.trim();
        if !configured.is_empty() {
            let path = PathBuf::from(configured);
            return if path.is_absolute() {
                Ok(path)
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(path))
                    .map_err(|error| error.to_string())
            };
        }
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".qone"))
        .ok_or_else(|| "Could not determine the Qone data directory".to_string())
}

pub fn runtime() -> Result<PathBuf, String> {
    Ok(root()?.join("runtime"))
}

pub fn auth() -> Result<PathBuf, String> {
    let directory = root()?.join("auth");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

pub fn webview() -> Result<PathBuf, String> {
    let directory = runtime()?.join("webview");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

pub fn ensure_global_instructions() -> Result<(), String> {
    let directory = root()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    auth()?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("Qone.md"))
    {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("Failed to create Qone.md: {error}")),
    }
}
