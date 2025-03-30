use base64::{Engine as _, engine::general_purpose};
use epub::doc::{EpubDoc, NavPoint};
use serde::Serialize;
use serde::ser::SerializeStruct;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

struct AppState {
    book: Mutex<Option<EpubDoc<BufReader<File>>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            book: Mutex::new(None),
        }
    }
}

struct MyNavPoint(NavPoint);

impl Serialize for MyNavPoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("NavPoint", 4)?;
        state.serialize_field("label", &self.0.label)?;
        state.serialize_field(
            "content",
            &self.0.content.to_string_lossy().replace("\\", "/"),
        )?;
        state.serialize_field("playOrder", &self.0.play_order)?;
        state.serialize_field(
            "children",
            &self
                .0
                .children
                .iter()
                .map(|x| MyNavPoint(x.clone()))
                .collect::<Vec<_>>(),
        )?;
        state.end()
    }
}

#[tauri::command]
fn fetch_resource(_app: tauri::AppHandle, state: tauri::State<AppState>, path: String) -> String {
    let Ok(mut book_guard) = state.book.lock() else {
        return String::new();
    };
    let book = book_guard.as_mut().unwrap();
    let Some(content) = book.get_resource_by_path(&path) else {
        eprintln!("ERR: get_resource_by_path({}) returned None.", &path);
        return String::new();
    };
    let Some(mime) = book.get_resource_mime_by_path(&path) else {
        eprintln!("ERR: get_resource_mime_by_path returned None.");
        return String::new();
    };
    drop(book_guard);

    if mime.starts_with("image/") {
        let mut buf = mime;
        buf.push_str(";base64,");
        general_purpose::STANDARD.encode_string(content, &mut buf);
        buf
    } else if mime.starts_with("text/") {
        String::from_utf8(content).unwrap_or_default()
    } else {
        eprintln!("ERR: Unexpected mime type: {}", mime);
        String::new()
    }
}

#[tauri::command]
fn get_toc(state: tauri::State<AppState>) -> String {
    let Ok(mut book_guard) = state.book.lock() else {
        return String::new();
    };
    let book = book_guard.as_mut().unwrap();
    let toc = book.toc.clone();
    drop(book_guard);

    serde_json::to_string(&MyNavPoint(NavPoint {
        label: String::new(),
        content: PathBuf::new(),
        children: toc,
        play_order: 0,
    }))
    .unwrap_or_default()
}

#[tauri::command]
fn open_epub(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    window: tauri::Window,
) -> String {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("EPUB", &["epub"])
        .blocking_pick_file()
    else {
        return String::new(); // did not choose
    };
    // open file
    let Ok(mut book) = EpubDoc::new(&file_path.to_string()) else {
        eprintln!("ERR: Failed to open file.");
        return String::new();
    };
    for (id, (path, mime)) in book.resources.iter() {
        println!(
            "Resource #{}\t{} ({})",
            id,
            path.to_str().unwrap_or("(non utf8 path)"),
            mime
        );
    }
    book.mdata("title").and_then(|title| {
        let Ok(_) = window.set_title(&title.to_string()) else {
            eprintln!("ERR: Failed to set window title.");
            return None;
        };
        Some(())
    });

    // set state and get content
    let Ok(mut book_guard) = state.book.lock() else {
        eprintln!("ERR: Failed to acquire lock.");
        return String::new();
    };
    let current_chapter_content = book.get_current_with_epub_uris();
    *book_guard = Some(book);
    drop(book_guard);
    let Ok(content) = current_chapter_content else {
        eprintln!("ERR: Failed to extract content.");
        return String::new();
    };
    String::from_utf8(content).unwrap_or_default()
}

fn goto_chapter(state: tauri::State<AppState>, offset: i32) -> String {
    let Ok(mut book_guard) = state.book.lock() else {
        return String::new();
    };
    let book = book_guard.as_mut().unwrap();
    let ok = if offset == 1 {
        book.go_next()
    } else if offset == -1 {
        book.go_prev()
    } else {
        false
    };
    if !ok {
        drop(book_guard);
        return String::new();
    }
    let current_chapter_content = book.get_current_with_epub_uris();
    drop(book_guard);
    let Ok(content) = current_chapter_content else {
        eprintln!("ERR: Failed to extract content.");
        return String::new();
    };
    String::from_utf8(content).unwrap_or_default()
}

#[tauri::command]
fn next_chapter(_app: tauri::AppHandle, state: tauri::State<AppState>) -> String {
    goto_chapter(state, 1)
}

#[tauri::command]
fn prev_chapter(_app: tauri::AppHandle, state: tauri::State<AppState>) -> String {
    goto_chapter(state, -1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            fetch_resource,
            get_toc,
            next_chapter,
            open_epub,
            prev_chapter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
