use std::sync::{Arc, Mutex};
use serde_json::value::RawValue;
use tauri::{ipc::Channel, AppHandle, Emitter, State};
use std::time::{Duration, Instant};

pub struct RuntimeBatch {
    events: Vec<Box<RawValue>>,
    deadline: Option<Instant>,
    interval: Duration,
    limit: usize,
}

impl RuntimeBatch {
    pub fn new(limit: usize, interval: Duration) -> Self {
        Self { events: Vec::with_capacity(limit), deadline: None, interval, limit }
    }

    pub fn push(&mut self, event: Box<RawValue>, now: Instant) -> bool {
        if self.events.is_empty() { self.deadline = Some(now + self.interval); }
        self.events.push(event);
        self.events.len() >= self.limit
    }

    pub fn timeout(&self, now: Instant) -> Duration {
        self.deadline.map(|deadline| deadline.saturating_duration_since(now)).unwrap_or(self.interval)
    }

    pub fn drain(&mut self) -> Vec<Box<RawValue>> {
        self.deadline = None;
        std::mem::take(&mut self.events)
    }
}

#[derive(Clone)]
pub struct RuntimePayload(Arc<Vec<Box<RawValue>>>);

impl serde::Serialize for RuntimePayload {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(self.0.as_ref(), serializer)
    }
}

#[derive(Clone, Default)]
pub struct RuntimeTransport(Arc<Mutex<Option<Channel<RuntimePayload>>>>);

impl RuntimeTransport {
    pub fn send(&self, app: &AppHandle, batch: Vec<Box<RawValue>>) {
        let payload = RuntimePayload(Arc::new(batch));
        self.deliver(payload, |payload| { let _ = app.emit("runtime-event", payload); });
    }

    fn deliver(&self, payload: RuntimePayload, fallback: impl FnOnce(RuntimePayload)) {
        let Ok(mut channel) = self.0.lock() else { return; };
        if let Some(channel) = channel.as_ref() {
            if channel.send(payload.clone()).is_ok() { return; }
        }
        *channel = None;
        fallback(payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(text: &str) -> Box<RawValue> { RawValue::from_string(text.to_owned()).unwrap() }

    #[test]
    fn continuous_input_does_not_move_the_first_event_deadline() {
        let now = Instant::now();
        let mut batch = RuntimeBatch::new(16, Duration::from_millis(8));
        assert!(!batch.push(event(r#"{"type":"first"}"#), now));
        assert!(!batch.push(event(r#"{"type":"second"}"#), now + Duration::from_millis(7)));
        assert_eq!(batch.timeout(now + Duration::from_millis(7)), Duration::from_millis(1));
        assert_eq!(batch.timeout(now + Duration::from_millis(9)), Duration::ZERO);
    }

    #[test]
    fn a_full_batch_drains_in_order_and_the_next_batch_gets_a_new_deadline() {
        let now = Instant::now();
        let mut batch = RuntimeBatch::new(2, Duration::from_millis(8));
        assert!(!batch.push(event(r#"{"type":"first"}"#), now));
        assert!(batch.push(event(r#"{"type":"second"}"#), now));
        assert_eq!(batch.drain().iter().map(|value| value.get()).collect::<Vec<_>>(), vec![r#"{"type":"first"}"#, r#"{"type":"second"}"#]);
        assert!(batch.drain().is_empty());
        assert_eq!(batch.timeout(now + Duration::from_secs(1)), Duration::from_millis(8));
        batch.push(event(r#"{"type":"next"}"#), now + Duration::from_secs(1));
        assert_eq!(batch.timeout(now + Duration::from_secs(1)), Duration::from_millis(8));
    }

    #[test]
    fn raw_ndjson_batches_are_structured_json_with_no_second_string_encoding() {
        let now = Instant::now();
        let mut batch = RuntimeBatch::new(16, Duration::from_millis(8));
        batch.push(event(r#"[{"type":"agent.event","event":{"type":"message.delta","payload":{"delta":"你好\n\"text\""}}}]"#), now);
        batch.push(event(r#"{"type":"runtime.exited"}"#), now);
        let payload = RuntimePayload(Arc::new(batch.drain()));
        assert!(Arc::ptr_eq(&payload.0, &payload.clone().0));
        let encoded = serde_json::to_string(&payload).unwrap();
        let decoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert!(decoded[0].is_array());
        assert_eq!(decoded[0][0]["event"]["payload"]["delta"], "你好\n\"text\"");
        assert_eq!(decoded[1]["type"], "runtime.exited");
    }

    #[test]
    fn a_failed_channel_falls_back_once_and_can_be_replaced_after_reload() {
        let transport = RuntimeTransport::default();
        let failed = Arc::new(Mutex::new(0));
        let failures = failed.clone();
        *transport.0.lock().unwrap() = Some(Channel::new(move |_| {
            *failures.lock().unwrap() += 1;
            Err(tauri::Error::Io(std::io::Error::other("renderer disconnected")))
        }));
        let payload = RuntimePayload(Arc::new(vec![event(r#"{"type":"first"}"#)]));
        let mut fallback = Vec::new();
        transport.deliver(payload.clone(), |value| fallback.push(serde_json::to_string(&value).unwrap()));
        assert!(transport.0.lock().unwrap().is_none());
        transport.deliver(payload, |value| fallback.push(serde_json::to_string(&value).unwrap()));
        assert_eq!(*failed.lock().unwrap(), 1);
        assert_eq!(fallback, vec![r#"[{"type":"first"}]"#, r#"[{"type":"first"}]"#]);
        let received = Arc::new(Mutex::new(Vec::new()));
        let captured = received.clone();
        *transport.0.lock().unwrap() = Some(Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(value) = body { captured.lock().unwrap().push(value); }
            Ok(())
        }));
        transport.deliver(RuntimePayload(Arc::new(vec![event(r#"{"type":"next"}"#)])), |_| panic!("working channel must not fall back"));
        assert_eq!(*received.lock().unwrap(), vec![r#"[{"type":"next"}]"#]);
    }
}

#[tauri::command]
pub fn runtime_subscribe(channel: Channel<RuntimePayload>, transport: State<'_, RuntimeTransport>) -> Result<(), String> {
    *transport.0.lock().map_err(|error| error.to_string())? = Some(channel);
    Ok(())
}
