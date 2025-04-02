use base64::{Engine as _, engine::general_purpose};
use epub::doc::{DocError, EpubDoc, NavPoint};
use serde::Serialize;
use serde::ser::SerializeStruct;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

type Epub = EpubDoc<BufReader<File>>;

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
}

struct AppState {
    book: Mutex<Option<Epub>>,
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

fn set_book(state: &tauri::State<AppState>, book: Epub) -> CmdResult<()> {
    let mut book_guard = state.book.lock().map_err(|_| CmdErr::NotSureWhat)?;
    *book_guard = Some(book);
    Ok(())
}

fn book_get_current(state: &tauri::State<AppState>) -> CmdResult<Vec<u8>> {
    let mut book_guard = state.book.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = book_guard.as_mut().unwrap();
    book.get_current_with_epub_uris()
        .map_err(|_| CmdErr::InvalidEpub)
}

fn book_get_resource_and_mime(
    state: &tauri::State<AppState>,
    path: &str,
) -> CmdResult<(Option<Vec<u8>>, Option<String>)> {
    let mut book_guard = state.book.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = book_guard.as_mut().unwrap();
    Ok((
        book.get_resource_by_path(&path),
        book.get_resource_mime_by_path(&path),
    ))
}

fn book_get_toc(state: &tauri::State<AppState>) -> CmdResult<Vec<NavPoint>> {
    let mut book_guard = state.book.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = book_guard.as_mut().unwrap();
    Ok(book.toc.clone())
}

fn book_navigate(state: &tauri::State<AppState>, command: NavigateOp) -> CmdResult<bool> {
    let mut book_guard = state.book.lock().map_err(|_| CmdErr::NotSureWhat)?;
    let book = book_guard.as_mut().unwrap();
    Ok(match command {
        NavigateOp::Next => book.go_next(),
        NavigateOp::Prev => book.go_prev(),
        NavigateOp::JumpTo(path) => book
            .resource_uri_to_chapter(&PathBuf::from(path))
            .map(|num| book.set_current_page(num))
            .unwrap_or_default(),
    })
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
    // open file
    let book = EpubDoc::new(&file_path.to_string()).map_err(|err| match err {
        DocError::IOError(err) => {
            eprintln!("ERR: Failed to open file: {}", err);
            CmdErr::FileNotOpened
        }
        _ => CmdErr::InvalidEpub,
    })?;
    for (id, (path, mime)) in book.resources.iter() {
        println!(
            "Resource #{}\t{} ({})",
            id,
            path.to_str().unwrap_or("(non utf8 path)"),
            mime
        );
    }
    if let Some(title) = book.mdata("title") {
        window.set_title(&title.to_string()).unwrap_or_else(|err| {
            eprintln!("ERR: Failed to set window title: {}.", err);
        });
    }

    set_book(&state, book)?;
    let content = book_get_current(&state)?;

    String::from_utf8(content).map_err(|_| CmdErr::InvalidEpub)
}

fn goto_chapter(state: tauri::State<AppState>, command: NavigateOp) -> CmdResult<String> {
    if !book_navigate(&state, command)? {
        return Ok(String::new());
    }
    let content = book_get_current(&state)?;
    String::from_utf8(content).map_err(|_| CmdErr::InvalidEpub)
}

#[tauri::command]
fn next_chapter(state: tauri::State<AppState>) -> CmdResult<String> {
    goto_chapter(state, NavigateOp::Next)
}

#[tauri::command]
fn prev_chapter(state: tauri::State<AppState>) -> CmdResult<String> {
    goto_chapter(state, NavigateOp::Prev)
}

#[tauri::command]
fn jump_to_chapter(state: tauri::State<AppState>, path: String) -> CmdResult<String> {
    goto_chapter(state, NavigateOp::JumpTo(path))
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
            jump_to_chapter,
            next_chapter,
            open_epub,
            prev_chapter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
