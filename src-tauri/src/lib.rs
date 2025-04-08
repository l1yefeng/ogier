mod css;

use base64::{Engine as _, engine::general_purpose};
use epub::doc::{DocError, EpubDoc, NavPoint};
use serde::Serialize;
use serde::ser::SerializeStruct;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::Mutex;
use std::{collections::HashMap, hash::Hasher};
use tauri::Manager;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::{StoreExt, resolve_store_path};
use twox_hash::XxHash64;

use css::regulate_css;

type Epub = EpubDoc<BufReader<File>>;
type EpubHash = arrayvec::ArrayString<16>;

#[derive(Serialize)]
enum CmdErr {
    NotSureWhat,
    FileNotOpened,
    InvalidEpub,
}

type CmdResult<T> = Result<T, CmdErr>;

enum NavigateOp {
    Next,
    Prev,
    JumpTo(String),
    JumpToChapter(usize),
}

struct AppData {
    book: Option<Epub>,
    book_hash: EpubHash,
}

impl AppData {
    fn new() -> Self {
        Self {
            book: None,
            book_hash: EpubHash::new(),
        }
    }
}

type AppState = Mutex<AppData>;

struct MyNavPoint(NavPoint);

impl Serialize for MyNavPoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("NavPoint", 4)?;
        state.serialize_field("label", &self.0.label)?;
        state.serialize_field("content", &self.0.content.to_string_lossy())?;
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

#[derive(Serialize)]
struct SpineItemData {
    position: usize,
    text: String,
}

const PROGRESS_STORE: &str = "progress.json";

fn book_get_current(state: &tauri::State<AppState>) -> CmdResult<SpineItemData> {
    let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_mut().unwrap();
    let text = book
        .get_current_with_epub_uris()
        .map_err(|_| CmdErr::InvalidEpub)?;
    let text = String::from_utf8(text).map_err(|_| CmdErr::InvalidEpub)?;
    let position = book.get_current_page();
    Ok(SpineItemData { position, text })
}

fn book_navigate(state: &tauri::State<AppState>, command: NavigateOp) -> CmdResult<bool> {
    let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_mut().unwrap();
    Ok(match command {
        NavigateOp::Next => book.go_next(),
        NavigateOp::Prev => book.go_prev(),
        NavigateOp::JumpTo(path) => book
            .resource_uri_to_chapter(&PathBuf::from(path))
            .map(|num| book.set_current_page(num))
            .unwrap_or_default(),
        NavigateOp::JumpToChapter(n) => book.set_current_page(n),
    })
}

fn book_save_progress(app: tauri::AppHandle, state: &tauri::State<AppState>) -> CmdResult<()> {
    let state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_ref().unwrap();
    let chapter_num = book.get_current_page();
    let book_hash = &state.book_hash;

    // Save progress to the store
    let progress = app.store(PROGRESS_STORE).map_err(|_| CmdErr::NotSureWhat)?;
    progress.set(book_hash.as_str(), chapter_num);
    Ok(())
}

fn compute_book_hash(filepath: &PathBuf) -> CmdResult<EpubHash> {
    let mut hasher = XxHash64::with_seed(0);

    let file = File::open(filepath).map_err(|_| CmdErr::FileNotOpened)?;
    let mut reader = BufReader::new(file);

    let mut buffer = [0u8; 8 * 1024];
    let mut remains = 1 << 20;
    while remains > 0 {
        let to_read = remains.min(buffer.len());
        let read = reader
            .read(&mut buffer[..to_read])
            .map_err(|_| CmdErr::FileNotOpened)?;
        if read == 0 {
            break;
        }
        hasher.write(&buffer[..read]);
        remains -= read;
    }

    let hash = hasher.finish();
    Ok(EpubHash::from(&format!("{:016x}", hash)).unwrap())
}

#[tauri::command]
fn get_resource(state: tauri::State<AppState>, path: String) -> CmdResult<String> {
    let (content, mime) = {
        let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
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
        let mut buf = mime;
        buf.push_str(";base64,");
        general_purpose::STANDARD.encode_string(content, &mut buf);
        Ok(buf)
    } else if mime.starts_with("text/") {
        let content = String::from_utf8(content).map_err(|_| CmdErr::InvalidEpub)?;
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
        let state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
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

fn navigate(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    command: NavigateOp,
) -> CmdResult<Option<SpineItemData>> {
    if !book_navigate(&state, command)? {
        return Ok(None);
    }
    book_save_progress(app, &state)?;
    book_get_current(&state).map(Some)
}

#[tauri::command]
fn navigate_next(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> CmdResult<Option<SpineItemData>> {
    navigate(app, state, NavigateOp::Next)
}

#[tauri::command]
fn navigate_prev(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> CmdResult<Option<SpineItemData>> {
    navigate(app, state, NavigateOp::Prev)
}

#[tauri::command]
fn navigate_to(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> CmdResult<Option<SpineItemData>> {
    navigate(app, state, NavigateOp::JumpTo(path))
}

#[tauri::command]
fn get_metadata(state: tauri::State<AppState>) -> CmdResult<HashMap<String, Vec<String>>> {
    let state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_ref().unwrap();
    Ok(book.metadata.clone())
}

fn custom_stylesheet_path(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
) -> CmdResult<PathBuf> {
    let mut css_path = {
        let state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
        resolve_store_path(&app, state.book_hash).map_err(|_| CmdErr::NotSureWhat)?
    };
    css_path.set_extension("json");
    Ok(css_path)
}

#[tauri::command]
fn open_custom_stylesheet(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<()> {
    let css_path = custom_stylesheet_path(&app, &state)?;
    app.opener()
        .open_path(css_path.to_string_lossy(), None::<&str>)
        .map_err(|_| CmdErr::NotSureWhat)
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
    std::fs::write(css_path, content).map_err(|_| CmdErr::FileNotOpened)
}

#[tauri::command]
fn open_epub(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    window: tauri::Window,
) -> CmdResult<Option<SpineItemData>> {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("EPUB", &["epub"])
        .blocking_pick_file()
    else {
        return Ok(None); // file picking was cancelled
    };
    let FilePath::Path(filepath) = file_path else {
        return Ok(None); // TODO unimplemented
    };
    // open file
    let book = EpubDoc::new(&filepath).map_err(|err| match err {
        DocError::IOError(err) => {
            eprintln!("ERR: Failed to open file: {}", err);
            CmdErr::FileNotOpened
        }
        _ => CmdErr::InvalidEpub,
    })?;
    // TODO(optimize) async
    if let Some(title) = book.mdata("title") {
        window.set_title(&title.to_string()).unwrap_or_else(|err| {
            eprintln!("ERR: Failed to set window title: {}.", err);
        });
    }

    let book_hash = compute_book_hash(&filepath)?;
    {
        let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
        state.book = Some(book);
        state.book_hash = book_hash;
    }

    // retrieve progress. this happens only once
    let progress = app.store(PROGRESS_STORE).map_err(|_| CmdErr::NotSureWhat)?;

    if let Some(serde_json::Value::Number(num)) = progress.get(book_hash) {
        // use read progress
        if let Some(chapter_num) = num.as_u64() {
            let _changed = book_navigate(&state, NavigateOp::JumpToChapter(chapter_num as usize))?;
        }
    }

    if let Some(menu) = window.menu() {
        let reader_submenu = menu.get("reader").unwrap();
        reader_submenu
            .as_submenu_unchecked()
            .set_enabled(true)
            .map_err(|_| CmdErr::NotSureWhat)?;
    }

    book_save_progress(app, &state)?;
    book_get_current(&state).map(Some)
}

fn setup_menu(app: &mut tauri::App) -> Result<(), Box<(dyn std::error::Error + 'static)>> {
    let handle = app.handle();
    let menu = Menu::new(handle)?;
    let file_submenu = SubmenuBuilder::new(handle, "File")
        .id("file")
        .item(
            &MenuItemBuilder::new("&Open EPUB")
                .id("file::open-epub")
                .build(handle)?,
        )
        .build()?;
    let reader_submenu = SubmenuBuilder::new(handle, "Reader")
        .id("reader")
        .item(
            &MenuItemBuilder::new("Open &Custom Stylesheet")
                .id("reader::open-custom-stylesheet")
                .build(handle)?,
        )
        .enabled(false)
        .build()?;
    menu.append_items(&[&file_submenu, &reader_submenu])?;
    app.set_menu(menu)?;
    app.on_menu_event(move |handle, event| match event.id().0.as_str() {
        "file::open-epub" => {
            println!("Open EPUB: Unimplemented");
        }
        "reader::open-custom-stylesheet" => {
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
        _ => {}
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppData::new()))
        .setup(setup_menu)
        .invoke_handler(tauri::generate_handler![
            get_custom_stylesheet,
            get_metadata,
            get_resource,
            get_toc,
            navigate_next,
            navigate_prev,
            navigate_to,
            open_custom_stylesheet,
            open_epub,
            set_custom_stylesheet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
