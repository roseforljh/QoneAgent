use std::sync::{Arc, Mutex};
use serde_json::value::RawValue;
use tauri::{ipc::Channel, AppHandle, Emitter, State};

#[derive(Clone, Default)]
pub struct RuntimeTransport(Arc<Mutex<Option<Channel<Vec<Box<RawValue>>>>>>);

impl RuntimeTransport {
    pub fn send(&self, app: &AppHandle, batch: Vec<Box<RawValue>>) {
        let Ok(channel) = self.0.lock() else { return; };
        if let Some(channel) = channel.as_ref() {
            let _ = channel.send(batch);
        } else {
            let _ = app.emit("runtime-event", batch);
        }
    }
}

#[tauri::command]
pub fn runtime_subscribe(channel: Channel<Vec<Box<RawValue>>>, transport: State<'_, RuntimeTransport>) -> Result<(), String> {
    *transport.0.lock().map_err(|error| error.to_string())? = Some(channel);
    Ok(())
}
