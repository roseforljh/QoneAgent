// Apply to every WebView, including dynamically created browser/preview tabs.
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("webview-policy")
        .js_init_script_on_all_frames(include_str!("webview-policy.js"))
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            windows_policy::install(&webview);
            #[cfg(not(windows))]
            let _ = webview;
        })
        .build()
}

#[cfg(windows)]
mod windows_policy {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2_11,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
    };
    use webview2_com::{CoTaskMemPWSTR, ContextMenuRequestedEventHandler, Result};
    use windows_core::Interface;

    #[derive(Default)]
    struct Target {
        editable: bool,
        selection: bool,
        link: bool,
        image: bool,
    }

    // WebView2 Name is the documented, nonlocalized lower-camel-case command
    // name. Retain native copy commands for the target; never match UI labels,
    // numeric command ids, page paths or DOM classes.
    fn allow_command(name: &str, target: &Target) -> bool {
        match name {
            "cut" | "paste" | "pasteAndMatchStyle" | "undo" | "redo" | "selectAll"
            | "spellCheck" => target.editable,
            "copy" => target.editable || target.selection,
            "saveImageAs" => target.image,
            _ => name.starts_with("copy") && (target.link || target.image),
        }
    }

    // No adjacent, leading or trailing separators after browser items are removed.
    fn retained_indices(items: &[(String, bool)], target: &Target) -> Vec<usize> {
        let mut indices = Vec::new();
        let mut separator = None;
        for (index, (name, is_separator)) in items.iter().enumerate() {
            if *is_separator {
                if !indices.is_empty() {
                    separator = Some(index);
                }
            } else if allow_command(name, target) {
                if let Some(index) = separator.take() {
                    indices.push(index);
                }
                indices.push(index);
            }
        }
        indices
    }

    unsafe fn filter_menu(args: &ICoreWebView2ContextMenuRequestedEventArgs) -> Result<bool> {
        let native_target = args.ContextMenuTarget()?;
        let mut editable = Default::default();
        let mut selection = Default::default();
        let mut link = Default::default();
        let mut kind = Default::default();
        native_target.IsEditable(&mut editable)?;
        native_target.HasSelection(&mut selection)?;
        native_target.HasLinkUri(&mut link)?;
        native_target.Kind(&mut kind)?;
        let target = Target {
            editable: editable.as_bool(),
            selection: selection.as_bool(),
            link: link.as_bool(),
            image: kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
        };
        let menu = args.MenuItems()?;
        let mut count = 0;
        menu.Count(&mut count)?;
        let mut items = Vec::with_capacity(count as usize);
        for index in 0..count {
            let item = menu.GetValueAtIndex(index)?;
            let mut name = Default::default();
            let mut kind = Default::default();
            item.Name(&mut name)?;
            let name = CoTaskMemPWSTR::from(name).to_string();
            item.Kind(&mut kind)?;
            // Only retain native commands, never an unchecked submenu tree.
            let name = if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND {
                name
            } else {
                String::new()
            };
            items.push((name, kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR));
        }
        let indices = retained_indices(&items, &target);
        let mut retained = indices.iter().rev().peekable();
        for index in (0..count).rev() {
            if retained.peek().is_some_and(|next| **next == index as usize) {
                retained.next();
            } else {
                menu.RemoveValueAtIndex(index)?;
            }
        }
        Ok(!indices.is_empty())
    }

    pub(super) fn install(webview: &tauri::Webview<tauri::Wry>) {
        let label = webview.label().to_owned();
        if let Err(error) = webview.with_webview(move |platform| {
            let result = (|| -> Result<()> {
                let core = unsafe { platform.controller().CoreWebView2()? };
                let settings = unsafe { core.Settings()? };
                unsafe {
                    // Unsupported runtime/setup failures leave menus disabled.
                    settings.SetAreDefaultContextMenusEnabled(false)?;
                    settings.SetAreDevToolsEnabled(false)?;
                }
                let menus: ICoreWebView2_11 = core.cast()?;
                let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    unsafe {
                        args.SetHandled(true)?;
                        match filter_menu(&args) {
                            Ok(true) => args.SetHandled(false)?,
                            Ok(false) => (),
                            Err(error) => {
                                eprintln!("[qone:webview-policy] menu suppressed: {error}")
                            }
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                unsafe {
                    // The WebView owns the handler and releases it when closed.
                    menus.add_ContextMenuRequested(&handler, &mut token)?;
                    settings.SetAreDefaultContextMenusEnabled(true)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("[qone:webview-policy] {label}: {error}");
            }
        }) {
            eprintln!("[qone:webview-policy] dispatch failed: {error}");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn blank_surfaces_have_no_browser_menu() {
            for name in [
                "back",
                "forward",
                "reload",
                "print",
                "saveAs",
                "viewSource",
                "inspect",
                "futureBrowserCommand",
                "copy",
                "selectAll",
            ] {
                assert!(!allow_command(name, &Target::default()), "{name}");
            }
        }

        #[test]
        fn editing_and_selection_keep_native_clipboard_operations() {
            let editable = Target {
                editable: true,
                ..Default::default()
            };
            for name in [
                "undo",
                "redo",
                "cut",
                "copy",
                "paste",
                "pasteAndMatchStyle",
                "selectAll",
                "spellCheck",
            ] {
                assert!(allow_command(name, &editable), "{name}");
            }
            let selection = Target {
                selection: true,
                ..Default::default()
            };
            assert!(allow_command("copy", &selection));
            assert!(!allow_command("cut", &selection));
            assert!(!allow_command("paste", &selection));
            assert!(!allow_command("inspect", &editable));
        }

        #[test]
        fn link_and_image_actions_cannot_open_browser_tools_or_windows() {
            let link = Target {
                link: true,
                ..Default::default()
            };
            let image = Target {
                image: true,
                ..Default::default()
            };
            assert!(allow_command("copyLink", &link));
            assert!(allow_command("copyLinkLocation", &link));
            assert!(allow_command("copyImage", &image));
            assert!(allow_command("saveImageAs", &image));
            assert!(!allow_command("saveImageAs", &link));
            for target in [&link, &image] {
                for name in [
                    "openLinkInNewWindow",
                    "openImageInNewTab",
                    "inspect",
                    "viewSource",
                    "print",
                    "saveAs",
                    "custom",
                    "share",
                ] {
                    assert!(!allow_command(name, target), "{name}");
                }
            }
        }

        #[test]
        fn removed_commands_do_not_leave_stray_separators() {
            let items = [
                ("", true),
                ("inspect", false),
                ("", true),
                ("copy", false),
                ("", true),
                ("viewSource", false),
                ("", true),
                ("paste", false),
                ("", true),
            ]
            .map(|(name, separator)| (name.to_owned(), separator));
            assert_eq!(
                retained_indices(
                    &items,
                    &Target {
                        editable: true,
                        ..Default::default()
                    }
                ),
                vec![3, 6, 7]
            );
            assert_eq!(
                retained_indices(
                    &items,
                    &Target {
                        selection: true,
                        ..Default::default()
                    }
                ),
                vec![3]
            );
            assert!(retained_indices(&items, &Target::default()).is_empty());
        }
    }
}
