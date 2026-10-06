use super::*;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn blocked_input_does_not_hold_the_terminal_registry() {
    let id = "test-blocked-input";
    let mut read_handle = HANDLE::default();
    let mut write_handle = HANDLE::default();
    unsafe {
        CreatePipe(&mut read_handle, &mut write_handle, None, 4096).unwrap();
    }
    let mut reader = HandleGuard::new(read_handle);
    let input = Arc::new(InputPipe {
        handle: write_handle.0 as usize,
        writer: Mutex::new(()),
    });
    PTYS.lock().unwrap().insert(
        id.to_owned(),
        Pty {
            hpc: HPCON::default(),
            input: input.clone(),
            process: 0,
            cols: 80,
            rows: 24,
        },
    );
    let writer = std::thread::spawn(move || write(id, &"x".repeat(1024 * 1024)));
    let deadline = Instant::now() + Duration::from_secs(2);
    while Arc::strong_count(&input) < 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    let acquired = Arc::strong_count(&input) >= 3;
    let registry_available = PTYS.try_lock().is_ok();
    // Closing the read end releases the blocked write before any assertion.
    reader.close();
    let result = writer.join().unwrap();
    PTYS.lock().unwrap().remove(id);
    assert!(acquired, "writer never acquired its own pipe reference");
    assert!(
        registry_available,
        "blocking WriteFile held the global registry"
    );
    assert!(
        result.is_err(),
        "a closed reader must stop the pending write"
    );
    assert_eq!(Arc::strong_count(&input), 1);
}

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
    // Resizing to the current geometry must not ask ConPTY to redraw.
    resize(id, 100, 30).unwrap();
    assert!(resize(id, 0, 30).is_err());
    assert!(resize(id, 100, -1).is_err());
    resize(id, 80, 24).unwrap();
    {
        let terminals = PTYS.lock().unwrap();
        let pty = terminals.get(id).unwrap();
        assert_eq!((pty.cols, pty.rows), (80, 24));
    }
    resize(id, 80, 24).unwrap();
    write(id, "Write-Output ('QONE_' + 'RESIZE_OK')\r").unwrap();
    read_until(id, &rx, "QONE_RESIZE_OK");
    write(id, "exit\r").unwrap();
}
