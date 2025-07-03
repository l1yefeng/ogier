mod alter;
mod epub;
mod errors;
mod menus;
mod mepub;
mod prefs;

use std::fs::File;
use std::hash::Hasher;
use std::io::{BufReader, Error as IoError, Read};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose};
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::{Store, StoreExt, resolve_store_path};
use twox_hash::XxHash64;

use alter::{alter_css, alter_xhtml};
use epub::{Epub, ResourceItem};
use errors::AnyErr;
use mepub::{EpubDetails, EpubFileInfo, EpubToc, SpineItem};

type EpubArchive = epub::EpubArchive<BufReader<File>>;
type EpubHash = arrayvec::ArrayString<16>;

#[derive(Default)]
struct AppData {
    book: Option<Epub>,
    book_file: Option<EpubArchive>,
    book_hash: EpubHash,
    book_file_info: EpubFileInfo,
    current_url: Option<url::Url>,
    setup_err: Option<AnyErr>,
}

type AppState = Mutex<AppData>;

const PROGRESS_STORE: &str = "progress.json";
const PREFS_STORE: &str = "prefs.json";

pub const MIMETYPE_XHTML: &str = "application/xhtml+xml";
pub const MIMETYPE_SVG: &str = "image/svg+xml";
pub const MIMETYPE_CSS: &str = "text/css";

// Helper functions, that tauri::commands depends on.
// Don't lock state within. Receive state as argument.

impl EpubArchive {
    fn read_to_string(&mut self, u: &url::Url) -> Result<String, AnyErr> {
        let mut reader = self.get_reader(u)?;
        let mut out = String::new();
        _ = reader.read_to_string(&mut out)?;
        Ok(out)
    }

    fn read_to_end(&mut self, u: &url::Url) -> Result<Vec<u8>, AnyErr> {
        let mut reader = self.get_reader(u)?;
        let mut out = Vec::new();
        _ = reader.read_to_end(&mut out)?;
        Ok(out)
    }
}

/// Acts on state.book. Returns the current spine item.
fn book_get_content(
    archive: &mut EpubArchive,
    doc_item: &ResourceItem,
) -> Result<SpineItem, AnyErr> {
    if !doc_item.media_type.eq_ignore_ascii_case(MIMETYPE_SVG)
        && !doc_item.media_type.eq_ignore_ascii_case(MIMETYPE_XHTML)
    {
        return Err(AnyErr::EpubContent);
    }

    let mut content = archive.read_to_string(&doc_item.url)?;
    if doc_item.media_type.eq_ignore_ascii_case(MIMETYPE_XHTML) {
        if let Some(c) = alter_xhtml(&content) {
            content = c;
        }
    }

    // TODO how to read
    Ok(SpineItem {
        position: 99,
        path: doc_item.url.clone(),
        text: content,
        mimetype: doc_item.media_type.clone(),
    })
}

/// Uses state.book. Also modifies progress store.
/// Save the current spine item position in state to store.
/// Optionally save the percentage.
/// The JSON value is an array of length 1 or 2.
fn book_progress_save<R: tauri::Runtime>(
    state: &AppData,
    progress_store: &Store<R>,
    percentage: Option<f64>,
) {
    let book_hash = state.book_hash.as_str();

    // Save progress to the store
    if let Some(current_url) = state.current_url.as_ref() {
        let value = match percentage {
            Some(f) => serde_json::json!([current_url, f]),
            None => serde_json::json!([current_url]),
        };
        progress_store.set(book_hash, value);
    } else {
        progress_store.set(book_hash, serde_json::json!(null));
    }
}

/// Uses state.book_hash. Also reads from progress store.
/// Parsed result is returned as tuple.
fn book_progress_load<R: tauri::Runtime>(
    state: &mut AppData,
    progress_store: &Store<R>,
) -> Option<(url::Url, Option<f64>)> {
    let value = progress_store.get(state.book_hash)?;
    let vec = value.as_array()?;
    let page_url = vec.get(0).and_then(|v| v.as_str())?;
    let Ok(page_url) = url::Url::parse(page_url) else {
        state.current_url = None;
        return None;
    };
    let percentage = vec.get(1).and_then(|v| v.as_f64());
    state.current_url = Some(page_url.clone());
    Some((page_url, percentage))
}

/// Do several things that are necessary when a book just opened.
fn post_book_open(window: &Window, state: &mut MutexGuard<'_, AppData>) -> Result<bool, AnyErr> {
    if let Some(setup_err) = state.setup_err.take() {
        return Err(setup_err);
    }

    let book = &state.book;
    let Some(book) = book else {
        return Ok(false);
    };

    // set window title with book title
    let title = match book.title() {
        Some(item) => format!("{} - OgierEPUB", item.value),
        None => String::from("OgierEPUB"),
    };
    let _ = window.set_title(&title);

    // update menu to complete
    let prefs_store = window.store(PREFS_STORE)?;
    menus::update(&window, &prefs_store)?;

    Ok(true)
}

/// Open a book at the given path. State mutex is locked all time.
/// When done, state is filled with the new data according to the book.
///
/// NOTE: It doesn't remember progress.
/// NOTE: It doesn't feed book info to app/window. For that, see post_book_open.
fn book_open(state: &mut MutexGuard<'_, AppData>, path: &PathBuf) -> Result<(), AnyErr> {
    log::info!("loading book at {}", path.to_string_lossy());

    // open file
    let file = File::open(path)?;
    let (book, book_file) = Epub::open(BufReader::new(file))?;

    let book_hash = compute_book_hash(&path)?;
    {
        let file_metadata = std::fs::metadata(&path)?;

        let as_ms = |time: SystemTime| {
            time.duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        };

        state.book = Some(book);
        state.book_file = Some(book_file);
        state.book_hash = book_hash;

        state.book_file_info.path = path.clone();
        state.book_file_info.size = file_metadata.len();
        state.book_file_info.created = file_metadata.created().map(as_ms).unwrap_or_default();
        state.book_file_info.modified = file_metadata.modified().map(as_ms).unwrap_or_default();
    }

    log::debug!("book opened and info extracted");

    Ok(())
}

/// Call only after book_open has been called.
fn book_get_init_page<R: tauri::Runtime>(
    state: &mut AppData,
    progress_store: &Store<R>,
) -> Result<(SpineItem, Option<f64>), AnyErr> {
    // retrieve progress
    if let Some((page_url, percentage)) = book_progress_load(state, progress_store) {
        let book = state.book.as_ref().unwrap();
        let nav_result = book.navigate_to(&page_url);
        if let Ok((item, _in_spine)) = nav_result {
            // get content and respond to front end
            let book_file = state.book_file.as_mut().unwrap();
            let spine_item = book_get_content(book_file, item)?;
            return Ok((spine_item, percentage));
        }
    }

    // use default initial position
    let book = state.book.as_ref().unwrap();
    let item = book.navigate_to_start();
    state.current_url = Some(item.url.clone());
    book_progress_save(state, progress_store, None);

    let book_file = state.book_file.as_mut().unwrap();
    let spine_item = book_get_content(book_file, item)?;
    Ok((spine_item, None))
}

// TODO: move out of lib.rs
fn compute_book_hash(filepath: &PathBuf) -> Result<EpubHash, IoError> {
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

// TODO: move out of lib.rs
fn resource_base64_encode(content: Vec<u8>, mime: String) -> String {
    let mut buf = mime;
    buf.push_str(";base64,");
    general_purpose::STANDARD.encode_string(content, &mut buf);
    buf
}

fn custom_styles_path(
    app_handle: &AppHandle,
    state: &MutexGuard<'_, AppData>,
) -> Result<PathBuf, AnyErr> {
    let mut path = resolve_store_path(app_handle, state.book_hash)?;
    path.set_extension("json");
    Ok(path)
}

// TODO: rename path -> url
#[tauri::command]
fn get_resource(state: State<AppState>, path: url::Url) -> Result<String, AnyErr> {
    log::debug!("command get_resource[{}]", path);
    let (content, mime) = {
        let state_guard = state.lock().unwrap();
        let book = state_guard.book.as_ref().unwrap();
        let resource = book.resource(&path)?;
        let mime = resource.media_type.clone();
        let mut state_guard = state.lock().unwrap();
        let book_file = state_guard.book_file.as_mut().unwrap();
        let content = book_file.read_to_end(&resource.url)?;
        (content, mime)
    };

    if mime.starts_with("image/") {
        Ok(resource_base64_encode(content, mime))
    } else if mime.starts_with("text/") {
        let content = str::from_utf8(&content).map_err(|_| AnyErr::EpubContent)?;
        if mime == MIMETYPE_CSS {
            Ok(alter_css(content).unwrap_or(content.into()))
        } else {
            Ok(content.into())
        }
    } else {
        log::warn!("cannot handle because of mimetype: {}", mime);
        Ok(String::new())
    }
}

#[tauri::command]
fn get_toc(state: State<AppState>) -> Result<EpubToc, AnyErr> {
    let url = {
        let state_guard = state.lock().unwrap();
        let book = state_guard.book.as_ref().unwrap();
        book.nav().map(|item| item.url.clone())
    };
    if let Some(url) = url {
        let mut state_guard = state.lock().unwrap();
        let book_file = state_guard.book_file.as_mut().unwrap();
        let xhtml = book_file.read_to_string(&url)?;
        return Ok(EpubToc::Nav { path: url, xhtml });
    }

    // // try the legacy NCX toc
    // let state_guard = state.lock().unwrap();
    // let book = state_guard.book.as_ref().unwrap();
    //
    // if !book.toc.is_empty() {
    //     return Ok(EpubToc::Ncx {
    //         root: MyNavPoint(NavPoint {
    //             label: book.toc_title.clone(),
    //             content: PathBuf::new(),
    //             children: book.toc.clone(),
    //             play_order: 0,
    //         }),
    //     });
    // }

    Err(AnyErr::EpubNoNav)
}

#[tauri::command]
fn navigate_adjacent(
    window: Window,
    state: State<AppState>,
    next: bool, // -> forward
) -> Result<Option<SpineItem>, AnyErr> {
    let dest = {
        let state_guard = state.lock().unwrap();
        let book = state_guard.book.as_ref().unwrap();
        let current_url = state_guard.current_url.as_ref().unwrap();
        let dest = book.navigate_from(current_url, next)?;
        dest.cloned()
    };
    if let Some(dest) = dest {
        let mut state_guard = state.lock().unwrap();
        state_guard.current_url = Some(dest.url.clone());
        let progress_store = window.store(PROGRESS_STORE)?;
        book_progress_save(&state_guard, &progress_store, None);
        let book_file = state_guard.book_file.as_mut().unwrap();
        book_get_content(book_file, &dest).map(Some)
    } else {
        // Not an error. Just means there is no next/prev page.
        return Ok(None);
    }
}

#[tauri::command]
fn navigate_to(
    window: Window,
    state: State<AppState>,
    path: url::Url,
) -> Result<SpineItem, AnyErr> {
    let item = {
        let state_guard = state.lock().unwrap();
        let book = state_guard.book.as_ref().unwrap();
        let (item, _in_spine) = book.navigate_to(&path)?;
        item.clone()
    };

    let mut state_guard = state.lock().unwrap();
    state_guard.current_url = Some(item.url.clone());
    let progress_store = window.store(PROGRESS_STORE)?;
    book_progress_save(&state_guard, &progress_store, None);
    let book_file = state_guard.book_file.as_mut().unwrap();
    book_get_content(book_file, &item)
}

#[tauri::command]
fn get_details(state: State<AppState>) -> Result<EpubDetails, AnyErr> {
    let (file_info, metadata, title) = {
        let state = state.lock().unwrap();
        let book = state.book.as_ref().unwrap();
        (
            state.book_file_info.clone(),
            book.metadata().clone(),
            book.title().map(|item| item.value.clone()),
        )
    };

    let display_title = title.unwrap_or_else(|| {
        String::from(
            file_info
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
        )
    });

    let mut cover_base64 = String::new();

    let mut state = state.lock().unwrap();
    let book = state.book.as_ref().unwrap();
    if let Some(item) = book.cover().cloned() {
        let book_file = state.book_file.as_mut().unwrap();
        let content = book_file.read_to_end(&item.url)?;
        cover_base64 = resource_base64_encode(content, item.media_type);
    }

    Ok(EpubDetails {
        file_info,
        metadata,
        spine_length: 0,
        display_title,
        cover_base64,
    })
}

#[tauri::command]
fn open_custom_stylesheet(app_handle: AppHandle, state: State<AppState>) -> Result<(), AnyErr> {
    let path = {
        let state_guard = state.lock().unwrap();
        custom_styles_path(&app_handle, &state_guard)?
    };
    app_handle
        .opener()
        .open_path(path.to_string_lossy(), None::<&str>)?;
    Ok(())
}

// TODO: rename (see README)
#[tauri::command]
fn get_custom_stylesheet(app_handle: AppHandle, state: State<AppState>) -> Result<String, AnyErr> {
    let path = {
        let state_guard = state.lock().unwrap();
        custom_styles_path(&app_handle, &state_guard)?
    };
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
fn set_custom_stylesheet(
    app_handle: AppHandle,
    state: State<AppState>,
    content: String,
) -> Result<(), AnyErr> {
    let path = {
        let state_guard = state.lock().unwrap();
        custom_styles_path(&app_handle, &state_guard)?
    };
    std::fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
fn set_reading_position(
    window: Window,
    state: State<AppState>,
    position: f64,
) -> Result<(), AnyErr> {
    let state_guard = state.lock().unwrap();
    let progress_store = window.store(PROGRESS_STORE)?;
    book_progress_save(&state_guard, &progress_store, Some(position));
    Ok(())
}

fn open_epub_impl(
    window: Window,
    state: State<AppState>,
    path: PathBuf,
) -> Result<(SpineItem, Option<f64>), AnyErr> {
    let progress_store = window.store(PROGRESS_STORE)?;
    let mut state_guard = state.lock().unwrap();
    book_open(&mut state_guard, &path)?;
    post_book_open(&window, &mut state_guard)?;
    book_get_init_page(&mut state_guard, &progress_store)
}

/// Front-end invokes this to view EPUB at the given path.
///
/// Returns the current page and the reading position in page.
#[tauri::command]
fn open_epub(
    window: Window,
    state: State<AppState>,
    path: PathBuf,
) -> Result<(SpineItem, Option<f64>), AnyErr> {
    log::debug!("command open_epub[{}]", path.to_string_lossy());
    open_epub_impl(window, state, path)
}

#[tauri::command]
fn reload_book(window: Window, state: State<AppState>) -> Result<(SpineItem, Option<f64>), AnyErr> {
    log::debug!("command reload_book");
    let path = {
        let state_guard = state.lock().unwrap();
        state_guard.book_file_info.path.clone()
    };

    open_epub_impl(window, state, path)
}

#[tauri::command]
fn open_epub_if_loaded(
    window: Window,
    state: State<AppState>,
) -> Result<Option<(SpineItem, Option<f64>)>, AnyErr> {
    log::debug!("command open_epub_if_loaded");
    let mut state_guard = state.lock().unwrap();
    let opened = post_book_open(&window, &mut state_guard)?;
    if !opened {
        log::debug!("no book was loaded");
        return Ok(None);
    }

    post_book_open(&window, &mut state_guard)?;
    let progress_store = window.store(PROGRESS_STORE)?;
    book_get_init_page(&mut state_guard, &progress_store).map(Some)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(filepath: Option<PathBuf>) {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppData::default()))
        .menu(|app_handle| menus::make(app_handle))
        .on_menu_event(|handle, event| menus::handle_menu_event(handle, event.id().0.as_str()))
        .setup(move |app| {
            log::debug!("setup");
            if let Some(filepath) = filepath {
                log::debug!(" with {}", filepath.to_string_lossy());
                let state = app.state::<AppState>();
                let mut state_guard = state.lock().unwrap();
                if let Err(err) = book_open(&mut state_guard, &filepath) {
                    state_guard.setup_err = Some(err);
                }
            }
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
            open_epub_if_loaded,
            open_epub,
            reload_book,
            set_custom_stylesheet,
            set_reading_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
