mod css;
mod error;
mod mepub;

use std::fs::File;
use std::hash::Hasher;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose};
use epub::doc::{DocError, EpubDoc, NavPoint};
use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::{StoreExt, resolve_store_path};
use twox_hash::XxHash64;

use css::regulate_css;
use error::Error;
use mepub::{EpubDetails, EpubFileInfo, MyNavPoint, Navigation, SpineItem};

type Epub = EpubDoc<BufReader<File>>;
type EpubHash = arrayvec::ArrayString<16>;

type CmdResult<T> = Result<T, Error>;

struct AppData {
    book: Option<Epub>,
    book_hash: EpubHash,
    book_file_info: EpubFileInfo,
}

impl AppData {
    fn new() -> Self {
        Self {
            book: None,
            book_hash: EpubHash::new(),
            book_file_info: EpubFileInfo {
                path: PathBuf::new(),
                size: 0,
                created: 0,
                modified: 0,
            },
        }
    }
}

type AppState = Mutex<AppData>;

const PROGRESS_STORE: &str = "progress.json";

fn book_get_current(state: &tauri::State<AppState>) -> CmdResult<SpineItem> {
    let mut state = state.lock().unwrap();
    let book = state.book.as_mut().unwrap();
    let text = book.get_current_with_epub_uris()?;
    let text = String::from_utf8(text)?;
    let position = book.get_current_page();
    let Some(path) = book.get_current_path() else {
        return Err(Error::Epub(DocError::InvalidEpub));
    };
    Ok(SpineItem {
        position,
        path,
        text,
    })
}

fn book_navigate(state: &tauri::State<AppState>, command: Navigation) -> CmdResult<bool> {
    let mut state = state.lock().unwrap();
    let book = state.book.as_mut().unwrap();
    Ok(match command {
        Navigation::Adjacent(true) => book.go_next(),
        Navigation::Adjacent(false) => book.go_prev(),
        Navigation::Position(n) => book.set_current_page(n),
    })
}

fn book_save_progress(app: tauri::AppHandle, state: &tauri::State<AppState>) -> CmdResult<()> {
    let state = state.lock().unwrap();
    let book = state.book.as_ref().unwrap();
    let chapter_num = book.get_current_page();
    let book_hash = &state.book_hash;

    // Save progress to the store
    let progress = app.store(PROGRESS_STORE)?;
    progress.set(book_hash.as_str(), chapter_num);
    Ok(())
}

fn compute_book_hash(filepath: &PathBuf) -> CmdResult<EpubHash> {
    let mut hasher = XxHash64::with_seed(0);

    let file = File::open(filepath)?;
    let mut reader = BufReader::new(file);

    let mut buffer = [0u8; 8 * 1024];
    let mut remains = 1 << 20;
    while remains > 0 {
        let to_read = remains.min(buffer.len());
        let read = reader.read(&mut buffer[..to_read])?;
        if read == 0 {
            break;
        }
        hasher.write(&buffer[..read]);
        remains -= read;
    }

    let hash = hasher.finish();
    Ok(EpubHash::from(&format!("{hash:016x}")).unwrap())
}

fn resource_base64_encoded(content: Vec<u8>, mime: String) -> String {
    let mut buf = mime;
    buf.push_str(";base64,");
    general_purpose::STANDARD.encode_string(content, &mut buf);
    buf
}

#[tauri::command]
fn get_resource(state: tauri::State<AppState>, path: String) -> CmdResult<String> {
    let (content, mime) = {
        let mut state = state.lock().unwrap();
        let book = state.book.as_mut().unwrap();
        (
            book.get_resource_by_path(&path),
            book.get_resource_mime_by_path(&path).unwrap_or_default(),
        )
    };
    let Some(content) = content else {
        return Ok(String::new());
    };

    if mime.starts_with("image/") {
        Ok(resource_base64_encoded(content, mime))
    } else if mime.starts_with("text/") {
        let content = String::from_utf8(content)?;
        if path.ends_with(".css") {
            Ok(regulate_css(&content).unwrap_or(content))
        } else {
            Ok(content)
        }
    } else {
        eprintln!("ERR: Unsupported MIME type: {}", mime);
        Ok(String::new())
    }
}

#[tauri::command]
fn get_toc(state: tauri::State<AppState>) -> CmdResult<MyNavPoint> {
    let toc = {
        let state = state.lock().unwrap();
        let book = state.book.as_ref().unwrap();
        book.toc.clone()
    };

    Ok(MyNavPoint(NavPoint {
        label: String::new(),
        content: PathBuf::new(),
        children: toc,
        play_order: 0,
    }))
}

#[tauri::command]
fn navigate_adjacent(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    next: bool,
) -> CmdResult<Option<SpineItem>> {
    if !book_navigate(&state, Navigation::Adjacent(next))? {
        // Not an error. Just means there is no next/prev page.
        return Ok(None);
    }
    book_save_progress(app, &state)?;
    book_get_current(&state).map(Some)
}

#[tauri::command]
fn reload_current(state: tauri::State<AppState>) -> CmdResult<SpineItem> {
    book_get_current(&state)
}

#[tauri::command]
fn navigate_to(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> CmdResult<SpineItem> {
    let Some(position) = ({
        let state = state.lock().unwrap();
        let book = state.book.as_ref().unwrap();
        book.resource_uri_to_chapter(&PathBuf::from(path))
    }) else {
        return Err(Error::ResourcePathNotFound);
    };

    if !book_navigate(&state, Navigation::Position(position))? {
        return Err(Error::Epub(DocError::InvalidEpub));
    }
    book_save_progress(app, &state)?;
    book_get_current(&state)
}

#[tauri::command]
fn get_details(state: tauri::State<AppState>) -> CmdResult<EpubDetails> {
    let file_info = {
        let state = state.lock().unwrap();
        state.book_file_info.clone()
    };
    let (spine_length, metadata, cover) = {
        let mut state = state.lock().unwrap();
        let book = state.book.as_mut().unwrap();

        (book.spine.len(), book.metadata.clone(), book.get_cover())
    };

    let title = metadata.get("title").and_then(|values| values.first());
    let display_title = match title {
        Some(title) => title.clone(),
        None => String::from(
            file_info
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
        ),
    };

    let cover_base64 = cover
        .map(|c_m| resource_base64_encoded(c_m.0, c_m.1))
        .unwrap_or_default();

    Ok(EpubDetails {
        file_info,
        metadata,
        spine_length,
        display_title,
        cover_base64,
    })
}

fn custom_stylesheet_path(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
) -> CmdResult<PathBuf> {
    let mut css_path = {
        let state = state.lock().unwrap();
        resolve_store_path(&app, state.book_hash)?
    };
    css_path.set_extension("json");
    Ok(css_path)
}

#[tauri::command]
fn open_custom_stylesheet(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<()> {
    let css_path = custom_stylesheet_path(&app, &state)?;
    app.opener()
        .open_path(css_path.to_string_lossy(), None::<&str>)?;
    Ok(())
}

#[tauri::command]
fn get_custom_stylesheet(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> CmdResult<String> {
    let css_path = custom_stylesheet_path(&app, &state)?;
    Ok(std::fs::read_to_string(css_path).unwrap_or_default())
}

#[tauri::command]
fn set_custom_stylesheet(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    content: String,
) -> CmdResult<()> {
    let css_path = custom_stylesheet_path(&app, &state)?;
    std::fs::write(css_path, content)?;
    Ok(())
}

#[tauri::command]
fn open_epub(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    window: tauri::Window,
) -> CmdResult<Option<SpineItem>> {
    let Some(filepath) = app
        .dialog()
        .file()
        .add_filter("EPUB", &["epub"])
        .blocking_pick_file()
    else {
        return Ok(None); // file picking was cancelled
    };
    let FilePath::Path(filepath) = filepath else {
        return Ok(None); // TODO unimplemented
    };
    // open file
    let book = EpubDoc::new(&filepath)?;
    // TODO(optimize) async
    if let Some(title) = book.mdata("title") {
        window.set_title(&title.to_string()).unwrap_or_else(|err| {
            eprintln!("ERR: Failed to set window title: {}.", err);
        });
    }

    let book_hash = compute_book_hash(&filepath)?;
    {
        let file_metadata = std::fs::metadata(&filepath)?;

        let as_ms = |time: SystemTime| {
            time.duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        };

        let mut state = state.lock().unwrap();
        state.book = Some(book);
        state.book_hash = book_hash;

        state.book_file_info.path = filepath.clone();
        state.book_file_info.size = file_metadata.len();
        state.book_file_info.created = file_metadata.created().map(as_ms).unwrap_or_default();
        state.book_file_info.modified = file_metadata.modified().map(as_ms).unwrap_or_default();
    }

    // retrieve progress. this happens only once
    let progress = app.store(PROGRESS_STORE)?;

    if let Some(serde_json::Value::Number(num)) = progress.get(book_hash) {
        // use read progress
        if let Some(chapter_num) = num.as_u64() {
            let _changed = book_navigate(&state, Navigation::Position(chapter_num as usize))?;
        }
    }

    complete_menu(&window)?;

    book_save_progress(app, &state)?;
    book_get_current(&state).map(Some)
}

fn complete_menu(window: &tauri::Window) -> Result<(), tauri::Error> {
    let menu = window.menu().unwrap();

    // File
    let file_submenu = menu.get("file").unwrap();
    file_submenu.as_submenu_unchecked().insert_items(
        &[
            &PredefinedMenuItem::separator(window)?,
            &MenuItemBuilder::new("&Details")
                .id("file::details")
                .build(window)?,
            &MenuItemBuilder::new("&Table of Contents")
                .id("file::table-of-contents")
                .build(window)?,
            &PredefinedMenuItem::separator(window)?,
        ],
        1,
    )?;

    // View
    let view_submenu = SubmenuBuilder::new(window, "View")
        .id("view")
        .text("view::open-custom-stylesheet", "Open &Custom Stylesheet")
        .build()?;
    menu.insert(&view_submenu, 1)?;

    Ok(())
}

fn setup_menu_listener(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    app.on_menu_event(move |handle, event| match event.id().0.as_str() {
        id @ ("file::details" | "file::table-of-contents") => {
            // Show table of contents in front end
            if let Err(err) = handle.emit_to("main", &format!("menu/{id}"), ()) {
                eprintln!("ERR: Failed to send event {}: {}", id, err)
            }
        }
        "view::open-custom-stylesheet" => {
            // Open preference file in system opener
            let state = handle.state();
            if let Ok(css_path) = custom_stylesheet_path(handle, &state) {
                if let Err(err) = handle
                    .opener()
                    .open_path(css_path.to_string_lossy(), None::<&str>)
                {
                    eprintln!("ERR: Failed to open custom stylesheet: {}", err);
                }
            }
        }
        "help::version" => {
            // TODO: https://v2.tauri.app/plugin/clipboard/
        }
        "help::website--support" => {
            // Open website in system opener
            if let Err(err) = handle
                .opener()
                .open_url("https://lyfeng.xyz/ogier", None::<&str>)
            {
                eprintln!("ERR: Failed to open website: {}", err);
            }
        }
        _ => {}
    });
    Ok(())
}

fn setup_menu(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let menu = Menu::new(app)?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .id("file")
        .text("file::open-epub", "&Open EPUB")
        .quit()
        .build()?;

    let help_submenu = SubmenuBuilder::new(app, "Help")
        .id("help")
        .text("help::version", "App &Version: dev")
        .item(
            &MenuItemBuilder::new("&Website && Support")
                .id("help::website--support")
                .build(app)?,
        )
        .about_with_text(
            "&License && Copyrights",
            Some(
                AboutMetadataBuilder::new()
                    .comments(Some("Ogier: a fast and simple EPUB reader (freeware)"))
                    .copyright(Some("Copyright 2025, Ogier EPUB Reader developers"))
                    .build(),
            ),
        )
        .build()?;

    menu.append_items(&[&file_submenu, &help_submenu])?;

    app.set_menu(menu)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppData::new()))
        .setup(|app| {
            let handle = app.handle();
            setup_menu(&handle)?;
            setup_menu_listener(&handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_custom_stylesheet,
            get_details,
            get_resource,
            get_toc,
            navigate_adjacent,
            navigate_to,
            open_custom_stylesheet,
            open_epub,
            reload_current,
            set_custom_stylesheet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
