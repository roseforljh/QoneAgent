#[derive(Debug, serde::Serialize)]
pub struct NativeError {
    pub code: &'static str,
    pub values: std::collections::BTreeMap<&'static str, String>,
}

impl NativeError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            values: Default::default(),
        }
    }

    pub fn detail(code: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            code,
            values: [("error", error.to_string())].into(),
        }
    }
}
