use epub::doc::{DocError, EpubDoc};
use tauri_plugin_dialog::DialogExt;

fn get_book_title(path: &str) -> Result<String, DocError> {
    match EpubDoc::new(path) {
        Ok(book) => Ok(book.mdata("title").unwrap_or("(no title)".to_owned())),
        Err(e) => Err(e),
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn open_epub(app_handle: tauri::AppHandle) -> String {
    let file_path = app_handle
        .dialog()
        .file()
        .add_filter("EPUB", &["epub"])
        .blocking_pick_file();
    match file_path {
        Some(path) => get_book_title(&path.to_string()).unwrap_or("(open failed)".to_owned()),
        None => String::new(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_epub])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
