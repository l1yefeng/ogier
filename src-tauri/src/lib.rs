use base64::{Engine as _, engine::general_purpose};
use epub::doc::{DocError, EpubDoc, NavPoint};
use serde::Serialize;
use serde::ser::SerializeStruct;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::Mutex;
use std::{collections::HashMap, hash::Hasher};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_store::StoreExt;
use twox_hash::XxHash64;

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

const PROGRESS_STORE: &str = "progress.json";

fn set_book(state: &tauri::State<AppState>, book: Epub, hash: EpubHash) -> CmdResult<()> {
    let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    state.book = Some(book);
    state.book_hash = hash;
    Ok(())
}

fn book_get_current(state: &tauri::State<AppState>) -> CmdResult<Vec<u8>> {
    let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_mut().unwrap();
    book.get_current_with_epub_uris()
        .map_err(|_| CmdErr::InvalidEpub)
}

fn book_get_resource_and_mime(
    state: &tauri::State<AppState>,
    path: &str,
) -> CmdResult<(Option<Vec<u8>>, Option<String>)> {
    let mut state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_mut().unwrap();
    Ok((
        book.get_resource_by_path(&path),
        book.get_resource_mime_by_path(&path),
    ))
}

fn book_get_toc(state: &tauri::State<AppState>) -> CmdResult<Vec<NavPoint>> {
    let state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_ref().unwrap();
    Ok(book.toc.clone())
}

fn book_get_metadata(state: &tauri::State<AppState>) -> CmdResult<HashMap<String, Vec<String>>> {
    let state = state.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = state.book.as_ref().unwrap();
    Ok(book.metadata.clone())
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
fn fetch_resource(state: tauri::State<AppState>, path: String) -> CmdResult<String> {
    let (content, mime) = book_get_resource_and_mime(&state, &path)?;
    let Some(content) = content else {
        return Ok(String::new());
    };
    let mime = mime.unwrap_or_default();

    if mime.starts_with("image/") {
        let mut buf = mime;
        buf.push_str(";base64,");
        general_purpose::STANDARD.encode_string(content, &mut buf);
        Ok(buf)
    } else if mime.starts_with("text/") {
        String::from_utf8(content).map_err(|_| CmdErr::InvalidEpub)
    } else {
        eprintln!("ERR: Unsupported MIME type: {}", mime);
        Ok(String::new())
    }
}

#[tauri::command]
fn get_toc(state: tauri::State<AppState>) -> CmdResult<MyNavPoint> {
    let toc = book_get_toc(&state)?;

    Ok(MyNavPoint(NavPoint {
        label: String::new(),
        content: PathBuf::new(),
        children: toc,
        play_order: 0,
    }))
}

#[tauri::command]
fn open_epub(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    window: tauri::Window,
) -> CmdResult<String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("EPUB", &["epub"])
        .blocking_pick_file()
    else {
        return Ok(String::new()); // file picking was cancelled
    };
    let FilePath::Path(filepath) = file_path else {
        return Ok(String::new()); // TODO unimplemented
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
    set_book(&state, book, book_hash)?;

    // retrieve progress. this happens only once
    let progress = app.store(PROGRESS_STORE).map_err(|_| CmdErr::NotSureWhat)?;

    if let Some(serde_json::Value::Number(num)) = progress.get(book_hash) {
        // use read progress
        if let Some(chapter_num) = num.as_u64() {
            let _changed = book_navigate(&state, NavigateOp::JumpToChapter(chapter_num as usize))?;
        }
    }

    book_save_progress(app, &state)?;
    let content = book_get_current(&state)?;

    String::from_utf8(content).map_err(|_| CmdErr::InvalidEpub)
}

fn goto_chapter(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    command: NavigateOp,
) -> CmdResult<String> {
    if !book_navigate(&state, command)? {
        return Ok(String::new());
    }
    book_save_progress(app, &state)?;
    let content = book_get_current(&state)?;
    String::from_utf8(content).map_err(|_| CmdErr::InvalidEpub)
}

#[tauri::command]
fn next_chapter(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<String> {
    goto_chapter(app, state, NavigateOp::Next)
}

#[tauri::command]
fn prev_chapter(app: tauri::AppHandle, state: tauri::State<AppState>) -> CmdResult<String> {
    goto_chapter(app, state, NavigateOp::Prev)
}

#[tauri::command]
fn jump_to_chapter(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> CmdResult<String> {
    goto_chapter(app, state, NavigateOp::JumpTo(path))
}

#[tauri::command]
fn get_metadata(state: tauri::State<AppState>) -> CmdResult<HashMap<String, Vec<String>>> {
    book_get_metadata(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppData::new()))
        .invoke_handler(tauri::generate_handler![
            fetch_resource,
            get_metadata,
            get_toc,
            jump_to_chapter,
            next_chapter,
            open_epub,
            prev_chapter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
