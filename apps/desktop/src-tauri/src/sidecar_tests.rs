use super::*;
use std::future::Future;
use std::task::{Context, Poll, Waker};

fn sidecar(state: SidecarState) -> Sidecar {
    Sidecar {
        state: Arc::new(Mutex::new(state)),
        generation: Arc::new(AtomicU64::new(0)),
        send_order: Arc::new(tauri::async_runtime::Mutex::new(())),
    }
}

#[test]
fn queued_commands_are_rejected_after_restart() {
    tauri::async_runtime::block_on(async {
        let runtime = sidecar(SidecarState {
            stdin: None,
            _child: None,
        });
        let order = runtime.send_order.lock().await;
        let mut command = Box::pin(runtime.send_ordered("old command".into()));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(command.as_mut().poll(&mut context), Poll::Pending));
        runtime.generation.store(1, Ordering::SeqCst);
        drop(order);
        assert!(command
            .await
            .unwrap_err()
            .contains("restarted before command delivery"));
    });
}

#[cfg(windows)]
#[test]
fn blocked_sidecar_input_does_not_hold_the_lifecycle_lock() {
    use std::os::windows::io::AsRawHandle;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::TerminateProcess;

    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let process = child.as_raw_handle();
    let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let runtime = sidecar(SidecarState {
        stdin: Some(input.clone()),
        _child: Some(child),
    });
    let worker = runtime.clone();
    let writer = std::thread::spawn(move || worker.send(&"x".repeat(1024 * 1024), 0));
    let deadline = Instant::now() + Duration::from_secs(2);
    while Arc::strong_count(&input) < 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    let acquired = Arc::strong_count(&input) >= 3;
    let lifecycle_available = runtime.state.try_lock().is_ok();
    // Cleanup also works when the old implementation holds the state lock.
    unsafe {
        TerminateProcess(HANDLE(process), 1).unwrap();
    }
    let result = writer.join().unwrap();
    runtime
        .state
        .lock()
        .unwrap()
        ._child
        .as_mut()
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        acquired,
        "writer did not acquire a separate input reference"
    );
    assert!(
        lifecycle_available,
        "blocking input held the process lifecycle lock"
    );
    assert!(
        result.is_err(),
        "terminating the child must release blocked input"
    );
}

#[cfg(windows)]
#[test]
fn runtime_sends_keep_fifo_order_on_blocking_workers() {
    use std::io::Read;
    tauri::async_runtime::block_on(async {
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.WriteLine($line) }"])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().unwrap();
        let mut output = child.stdout.take().unwrap();
        let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let runtime = sidecar(SidecarState {
            stdin: Some(input),
            _child: Some(child),
        });
        let order = runtime.send_order.lock().await;
        let mut commands = Vec::new();
        let mut context = Context::from_waker(Waker::noop());
        for line in ["first", "second", "third"] {
            let worker = runtime.clone();
            let mut command = Box::pin(async move { worker.send_ordered(line.into()).await });
            assert!(matches!(command.as_mut().poll(&mut context), Poll::Pending));
            commands.push(command);
        }
        drop(order);
        // Submit in reverse worker order; the already registered send queue
        // must preserve the original command order.
        let tasks: Vec<_> = commands
            .into_iter()
            .rev()
            .map(tauri::async_runtime::spawn)
            .collect();
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        runtime.state.lock().unwrap().stdin.take();
        let mut text = String::new();
        output.read_to_string(&mut text).unwrap();
        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            ["first", "second", "third"]
        );
    });
}
