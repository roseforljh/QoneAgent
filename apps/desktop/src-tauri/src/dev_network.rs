// Native diagnostics only in debug builds; no browser automation or remote port.
use std::{cell::{Cell, RefCell}, collections::HashMap, io::Write, rc::Rc};
use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR,
    DevToolsProtocolEventReceivedEventHandler,
};

pub fn log(message: &str) {
    eprintln!("[qone:webview] {message}");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true)
        .open(std::env::temp_dir().join("qone-webview-startup.log")) {
        let _ = writeln!(file, "{message}");
    }
}

fn recover_cache(core: &ICoreWebView2, recovering: &Cell<bool>) {
    if recovering.replace(true) { return; }
    // Clear only the HTTP resource cache. Cookies, localStorage and IndexedDB
    // (including user settings) must survive recovery.
    let name = CoTaskMemPWSTR::from("Network.clearBrowserCache");
    let params = CoTaskMemPWSTR::from("{}");
    let reload = core.clone();
    let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
        match result {
            Ok(()) => {
                log("Resource cache cleared after ERR_CACHE_READ_FAILURE; reloading once");
                unsafe { reload.Reload()?; }
            }
            Err(error) => log(&format!("Resource cache recovery failed: {error}")),
        }
        Ok(())
    }));
    if let Err(error) = unsafe { core.CallDevToolsProtocolMethod(*name.as_ref().as_pcwstr(), *params.as_ref().as_pcwstr(), &callback) } {
        log(&format!("Resource cache recovery failed: {error}"));
    }
}

pub fn install(app: &tauri::AppHandle) {
    let _ = std::fs::write(std::env::temp_dir().join("qone-webview-startup.log"), "");
    let Some(window) = app.get_webview_window("main") else { return; };
    let _ = window.with_webview(|webview| {
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let core = unsafe { webview.controller().CoreWebView2()? };
            let requests = Rc::new(RefCell::new(HashMap::<String, String>::new()));
            let recovering = Rc::new(Cell::new(false));
            for event in ["Network.requestWillBeSent", "Network.loadingFailed", "Network.loadingFinished", "Log.entryAdded"] {
                let name = CoTaskMemPWSTR::from(event);
                let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(*name.as_ref().as_pcwstr())? };
                let requests = requests.clone();
                let recovery_core = core.clone();
                let recovering = recovering.clone();
                let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut raw = Default::default();
                        unsafe { args.ParameterObjectAsJson(&mut raw)?; }
                        let owned = CoTaskMemPWSTR::from(raw);
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&owned.to_string()) {
                            let id = value["requestId"].as_str().unwrap_or_default();
                            match event {
                                "Network.requestWillBeSent" => {
                                    if value["type"] == "Script" {
                                        if let Some(url) = value["request"]["url"].as_str().filter(|url| url.starts_with("http://127.0.0.1:1420/")) {
                                            requests.borrow_mut().insert(id.into(), url.into());
                                        }
                                    }
                                }
                                "Network.loadingFailed" => {
                                    if let Some(url) = requests.borrow_mut().remove(id) {
                                        log(&format!("{url}: error={} blocked={} cors={}", value["errorText"], value["blockedReason"], value["corsErrorStatus"]));
                                        if value["errorText"] == "net::ERR_CACHE_READ_FAILURE" {
                                            recover_cache(&recovery_core, &recovering);
                                        }
                                    }
                                }
                                "Network.loadingFinished" => { requests.borrow_mut().remove(id); }
                                "Log.entryAdded" => {
                                    let entry = &value["entry"];
                                    if entry["level"] == "error" && matches!(entry["source"].as_str(), Some("network" | "security")) {
                                        log(&format!("{} {}", entry["url"], entry["text"]));
                                        if entry["text"].as_str().is_some_and(|text| text.contains("net::ERR_CACHE_READ_FAILURE"))
                                            && entry["url"].as_str().is_some_and(|url| url.starts_with("http://127.0.0.1:1420/")) {
                                            recover_cache(&recovery_core, &recovering);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)?; }
            }
            for (method, parameters) in [
                ("Network.enable", "{}"),
                ("Log.enable", "{}"),
                // Dev assets must come from the current Vite server, not a
                // failed WebView disk-cache entry from a previous process.
                ("Network.setCacheDisabled", "{\"cacheDisabled\":true}"),
            ] {
                let name = CoTaskMemPWSTR::from(method);
                let params = CoTaskMemPWSTR::from(parameters);
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                    match result {
                        Ok(()) => log(&format!("{method} enabled")),
                        Err(error) => log(&format!("{method} failed: {error}")),
                    }
                    Ok(())
                }));
                unsafe { core.CallDevToolsProtocolMethod(*name.as_ref().as_pcwstr(), *params.as_ref().as_pcwstr(), &callback)?; }
            }
            log("Native network diagnostics enabled");
            Ok(())
        })();
        if let Err(error) = result { log(&format!("Diagnostics setup failed: {error}")); }
    });
}
