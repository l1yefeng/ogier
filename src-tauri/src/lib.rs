use epub::doc::EpubDoc;
use std::fs::File;
use std::io::BufReader;
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

#[tauri::command]
fn open_epub(app: tauri::AppHandle, state: tauri::State<AppState>) -> String {
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

#[tauri::command]
fn next_chapter(_app: tauri::AppHandle, state: tauri::State<AppState>) -> String {
    let Ok(mut book_guard) = state.book.lock() else {
        return String::new();
    };
    let book = book_guard.as_mut().unwrap();
    if !book.go_next() {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![open_epub, next_chapter])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
