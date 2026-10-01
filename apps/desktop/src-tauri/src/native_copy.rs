use std::sync::Mutex;
use tauri::menu::MenuItem;

#[derive(Clone, serde::Deserialize)]
pub struct NativeCopy {
    pub show: String,
    pub quit: String,
    pub completed: String,
}

pub struct NativeCopyState {
    pub copy: Mutex<NativeCopy>,
    pub show: MenuItem<tauri::Wry>,
    pub quit: MenuItem<tauri::Wry>,
}

#[tauri::command]
pub fn set_native_copy(copy: NativeCopy, state: tauri::State<'_, NativeCopyState>) -> Result<(), String> {
    state.show.set_text(&copy.show).map_err(|error| error.to_string())?;
    state.quit.set_text(&copy.quit).map_err(|error| error.to_string())?;
    *state.copy.lock().map_err(|error| error.to_string())? = copy;
    Ok(())
}
