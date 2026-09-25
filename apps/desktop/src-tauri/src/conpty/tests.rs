use super::*;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn read_until(id: &str, rx: &Receiver<String>, marker: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut output = String::new();
    while Instant::now() < deadline {
        if let Ok(data) = rx.recv_timeout(Duration::from_millis(100)) {
            // A terminal emulator replies to ConPTY's cursor-position query.
            if data.contains("\x1b[6n") {
                write(id, "\x1b[1;1R").unwrap();
            }
            output.push_str(&data);
            if output.contains(marker) {
                return output;
            }
        }
    }
    panic!("missing {marker:?}; output: {output:?}");
}

#[test]
fn powershell_prompt_and_interactive_input() {
    let id = "test-powershell-interaction";
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = kill("test-powershell-interaction");
        }
    }
    let _cleanup = Cleanup;
    let cwd = std::env::current_dir().unwrap();
    let (tx, rx) = channel();
    spawn_with_events(
        id,
        "pwsh.exe -NoProfile",
        cwd.to_str(),
        100,
        30,
        Arc::new(move |event, payload| {
            if event == "terminal:data" {
                let _ = tx.send(payload["data"].as_str().unwrap().to_owned());
            }
        }),
    )
    .unwrap();
    read_until(id, &rx, &format!("PS {}>", cwd.display()));
    write(id, "Write-Output ('QONE_' + 'INPUT_OK')\r").unwrap();
    read_until(id, &rx, "QONE_INPUT_OK");
    resize(id, 80, 24).unwrap();
    write(id, "exit\r").unwrap();
}
