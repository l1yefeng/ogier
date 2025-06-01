mod alter;
mod error;
mod menus;
mod mepub;
mod prefs;

use std::fs::File;
use std::hash::Hasher;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose};
use epub::doc::{DocError, EpubDoc, NavPoint, ResourceItem};
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::{Store, StoreExt, resolve_store_path};
use twox_hash::XxHash64;

use alter::{alter_css, alter_xhtml};
use error::Error;
use mepub::{
    EpubDetails, EpubFileInfo, EpubToc, MyMetadataItem, MyNavPoint, Navigation, SpineItem,
};
use prefs::{FontPrefer, FontSubstitute};

type Epub = EpubDoc<BufReader<File>>;
type EpubHash = arrayvec::ArrayString<16>;

type CmdResult<T> = Result<T, Error>;

#[derive(Default)]
struct AppData {
    book: Option<Epub>,
    book_hash: EpubHash,
    book_file_info: EpubFileInfo,
    prefs_font_substitute: FontSubstitute, // TODO remove
}

type AppState = Mutex<AppData>;

const PROGRESS_STORE: &str = "progress.json";
const PREFS_STORE: &str = "prefs.json";

pub const MIMETYPE_XHTML: &str = "application/xhtml+xml";
pub const MIMETYPE_SVG: &str = "image/svg+xml";
pub const MIMETYPE_CSS: &str = "text/css";

// Helper functions, that tauri::commands depends on.
// Don't lock state within. Receive state as argument.

/// Acts on state.book. Returns the current spine item.
fn book_get_current(state: &mut MutexGuard<'_, AppData>) -> CmdResult<SpineItem> {
    let book = state.book.as_mut().unwrap();
    let text = book.get_current_with_epub_uris()?;
    let mut text = String::from_utf8(text)?;
    let position = book.get_current_page();
    let Some(path) = book.get_current_path() else {
        return Err(Error::Epub(DocError::InvalidEpub));
    };
    let path = if cfg!(windows) {
        path.to_string_lossy().replace('\\', "/")
    } else {
        path.to_string_lossy().to_string()
    };
    let Some(mimetype) = book.get_current_mime() else {
        return Err(Error::Epub(DocError::InvalidEpub));
    };
    if !mimetype.eq_ignore_ascii_case(MIMETYPE_SVG)
        && !mimetype.eq_ignore_ascii_case(MIMETYPE_XHTML)
    {
        return Err(Error::Epub(DocError::InvalidEpub));
    }

    if mimetype.eq_ignore_ascii_case(MIMETYPE_XHTML) {
        text = alter_xhtml(&text).unwrap_or(text);
    }

    Ok(SpineItem {
        position,
        path,
        text,
        mimetype,
    })
}

/// Acts on state.book. Navigate (change the current spine item) the spine.
/// Returns false if going next/prev when at the end/beginning.
fn book_navigate(state: &mut MutexGuard<'_, AppData>, command: Navigation) -> CmdResult<bool> {
    let book = state.book.as_mut().unwrap();
    Ok(match command {
        Navigation::Adjacent(true) => book.go_next(),
        Navigation::Adjacent(false) => book.go_prev(),
        Navigation::Position(n) => book.set_current_page(n),
    })
}

/// Acts on state.book. Find toc nav in the book.
/// If a document contains one, returns its path and its content.
fn book_get_nav_doc(state: &mut MutexGuard<'_, AppData>) -> Option<(String, String)> {
    let book = state.book.as_mut().unwrap();
    let id = book.get_nav_id()?;
    let ResourceItem { path, .. } = book.resources.get(&id)?;

    // TODO fix it in epub-rs
    let path = {
        let mut components = Vec::new();
        path.components().for_each(|component| {
            let c = component.as_os_str();
            if c == ".." {
                _ = components.pop();
            } else {
                components.push(c.to_string_lossy());
            }
        });
        components.join("/")
    };

    let content = book.get_resource_str_by_path(&path)?;
    Some((path, content))
}

/// Uses state.book. Also modifies progress store.
/// Save the current spine item position in state to store.
/// Optionally save the percentage.
/// The JSON value is an array of length 1 or 2.
fn book_progress_save<R>(
    state: &MutexGuard<'_, AppData>,
    progress_store: &Store<R>,
    percentage: Option<f64>,
) -> CmdResult<()>
where
    R: tauri::Runtime,
{
    let book = state.book.as_ref().unwrap();
    let pos_in_spine = book.get_current_page();
    let book_hash = state.book_hash.as_str();

    // Save progress to the store
    let value = match percentage {
        Some(f) => serde_json::json!([pos_in_spine, f]),
        None => serde_json::json!([pos_in_spine]),
    };
    progress_store.set(book_hash, value);
    Ok(())
}

/// Uses state.book_hash. Also reads from progress store.
/// Parsed result is returned as tuple.
fn book_progress_load<R>(
    state: &MutexGuard<'_, AppData>,
    progress_store: &Store<R>,
) -> Option<(u64, Option<f64>)>
where
    R: tauri::Runtime,
{
    let Some(serde_json::Value::Array(vec)) = progress_store.get(state.book_hash) else {
        // No value or non-array value.
        return None;
    };

    let in_spine = match vec.get(0) {
        Some(serde_json::Value::Number(num)) => num.as_u64(),
        _ => None,
    };
    let Some(in_spine) = in_spine else {
        return None;
    };

    let in_page = match vec.get(1) {
        Some(serde_json::Value::Number(num)) => num.as_f64(),
        _ => None,
    };
    Some((in_spine, in_page))
}

/// Cache part of prefs from store in state.
/// Do call this after relevant prefs are changed in store.
fn cache_prefs_in_state<R>(
    state: &mut MutexGuard<'_, AppData>,
    prefs_store: &Store<R>,
) -> CmdResult<()>
where
    R: tauri::Runtime,
{
    // font.substitute
    state.prefs_font_substitute.clear();
    if let Some(value) = prefs_store.get("font.substitute") {
        let serde_json::Value::Object(value) = value else {
            return Err(error::Error::InvalidPrefs);
        };
        for (font, subs) in value.iter() {
            let serde_json::Value::String(subs) = subs else {
                return Err(error::Error::InvalidPrefs);
            };
            state
                .prefs_font_substitute
                .insert(font.clone(), subs.clone());
        }
    }

    Ok(())
}

/// Do several things that are necessary when a book just opened.
fn post_book_open(window: &Window, state: &MutexGuard<'_, AppData>) -> CmdResult<bool> {
    let book = &state.book;
    let Some(book) = book else {
        return Ok(false);
    };

    // set window title with book title
    let title = match book.get_title() {
        Some(book_title) => format!("{} - OgierEPUB", book_title),
        None => String::from("OgierEPUB"),
    };
    let _ = window.set_title(&title);

    // update menu to complete
    menus::update(&window)?;

    let font_prefer_value = {
        let prefs = window.store(PREFS_STORE)?;
        prefs.get("font.prefer")
    };
    // not always necessary, because this part of menu depends on prefs, not books.
    // but considering
    menus::set_font_preference(
        &window,
        match font_prefer_value {
            Some(serde_json::Value::String(value)) if value == "sans-serif" => {
                Some(FontPrefer::SansSerif)
            }
            Some(serde_json::Value::String(value)) if value == "serif" => Some(FontPrefer::Serif),
            _ => None,
        },
    )?;

    Ok(true)
}

/// Open a book at the given path. State mutex is locked all time.
/// When done, state is filled with the new data according to the book.
///
/// NOTE: It doesn't remember progress.
/// NOTE: It doesn't feed book info to app/window. For that, see post_book_open.
fn book_open(state: &mut MutexGuard<'_, AppData>, path: &PathBuf) -> CmdResult<()> {
    log::info!("loading book at {}", path.to_string_lossy());

    // open file
    let book = EpubDoc::new(&path)?;

    let book_hash = compute_book_hash(&path)?;
    {
        let file_metadata = std::fs::metadata(&path)?;

        let as_ms = |time: SystemTime| {
            time.duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        };

        state.book = Some(book);
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
fn book_get_init_page<R>(
    state: &mut MutexGuard<'_, AppData>,
    progress_store: &Store<R>,
) -> CmdResult<(SpineItem, Option<f64>)>
where
    R: tauri::Runtime,
{
    // retrieve progress
    let mut percentage = None;
    if let Some(progress) = book_progress_load(state, progress_store) {
        let (in_spine, in_page) = progress;
        percentage = in_page;
        let ok = book_navigate(state, Navigation::Position(in_spine as usize))?;
        if !ok {
            book_progress_save(state, progress_store, None)?;
            percentage = None;
        }
    }

    let spine_item = book_get_current(state)?;
    Ok((spine_item, percentage))
}

// TODO: move out of lib.rs
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
) -> CmdResult<PathBuf> {
    let mut path = resolve_store_path(app_handle, state.book_hash)?;
    path.set_extension("json");
    Ok(path)
}

#[tauri::command]
fn get_resource(state: State<AppState>, path: PathBuf) -> CmdResult<String> {
    log::debug!("command get_resource[{}]", path.to_string_lossy());
    let (content, mime) = {
        let mut state_guard = state.lock().unwrap();
        let book = state_guard.book.as_mut().unwrap();
        (
            book.get_resource_by_path(&path),
            book.get_resource_mime_by_path(&path).unwrap_or_default(),
        )
    };
    let Some(content) = content else {
        return Ok(String::new());
    };

    if mime.starts_with("image/") {
        Ok(resource_base64_encode(content, mime))
    } else if mime.starts_with("text/") {
        let content = String::from_utf8(content)?;
        if mime == MIMETYPE_CSS {
            Ok(alter_css(&content).unwrap_or(content))
        } else {
            Ok(content)
        }
    } else {
        log::warn!("cannot handle because of mimetype: {}", mime);
        Ok(String::new())
    }
}

#[tauri::command]
fn get_toc(state: State<AppState>) -> CmdResult<EpubToc> {
    if let Some((path, xhtml)) = book_get_nav_doc(&mut state.lock().unwrap()) {
        return Ok(EpubToc::Nav { path, xhtml });
    }

    // try the legacy NCX toc
    let state_guard = state.lock().unwrap();
    let book = state_guard.book.as_ref().unwrap();

    if !book.toc.is_empty() {
        return Ok(EpubToc::Ncx {
            root: MyNavPoint(NavPoint {
                label: book.toc_title.clone(),
                content: PathBuf::new(),
                children: book.toc.clone(),
                play_order: 0,
            }),
        });
    }

    Err(error::Error::EpubHasNoToc)
}

#[tauri::command]
fn navigate_adjacent(
    window: Window,
    state: State<AppState>,
    next: bool,
) -> CmdResult<Option<SpineItem>> {
    let mut state_guard = state.lock().unwrap();
    {
        if !book_navigate(&mut state_guard, Navigation::Adjacent(next))? {
            // Not an error. Just means there is no next/prev page.
            return Ok(None);
        }
    }
    let progress_store = window.store(PROGRESS_STORE)?;
    book_progress_save(&state_guard, &progress_store, None)?;
    book_get_current(&mut state_guard).map(Some)
}

#[tauri::command]
fn navigate_to(window: Window, state: State<AppState>, path: String) -> CmdResult<SpineItem> {
    let Some(position) = ({
        let state = state.lock().unwrap();
        let book = state.book.as_ref().unwrap();
        book.resource_uri_to_chapter(&PathBuf::from(path))
    }) else {
        return Err(Error::ResourcePathNotFound);
    };

    let mut state_guard = state.lock().unwrap();

    if !book_navigate(&mut state_guard, Navigation::Position(position))? {
        return Err(Error::Epub(DocError::InvalidEpub));
    }
    let progress_store = window.store(PROGRESS_STORE)?;
    book_progress_save(&state_guard, &progress_store, None)?;
    book_get_current(&mut state_guard)
}

#[tauri::command]
fn get_details(state: State<AppState>) -> CmdResult<EpubDetails> {
    let file_info = {
        let state = state.lock().unwrap();
        state.book_file_info.clone()
    };
    let (spine_length, metadata, cover) = {
        let mut state = state.lock().unwrap();
        let book = state.book.as_mut().unwrap();

        (book.spine.len(), book.metadata.clone(), book.get_cover())
    };

    let display_title = metadata
        .iter()
        .find(|item| item.property == "title")
        .map_or_else(
            || {
                String::from(
                    file_info
                        .path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default(),
                )
            },
            |item| item.value.clone(),
        );

    let cover_base64 = cover
        .map(|(content, mime)| resource_base64_encode(content, mime))
        .unwrap_or_default();

    Ok(EpubDetails {
        file_info,
        metadata: metadata
            .into_iter()
            .map(|item| MyMetadataItem(item))
            .collect(),
        spine_length,
        display_title,
        cover_base64,
    })
}

#[tauri::command]
fn open_custom_stylesheet(app_handle: AppHandle, state: State<AppState>) -> CmdResult<()> {
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
fn get_custom_stylesheet(app_handle: AppHandle, state: State<AppState>) -> CmdResult<String> {
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
) -> CmdResult<()> {
    let path = {
        let state_guard = state.lock().unwrap();
        custom_styles_path(&app_handle, &state_guard)?
    };
    std::fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
fn set_reading_position(window: Window, state: State<AppState>, position: f64) -> CmdResult<()> {
    let state_guard = state.lock().unwrap();
    let progress_store = window.store(PROGRESS_STORE)?;
    book_progress_save(&state_guard, &progress_store, Some(position))
}

fn open_epub_impl(
    window: Window,
    state: State<AppState>,
    path: PathBuf,
) -> CmdResult<(SpineItem, Option<f64>)> {
    let progress_store = window.store(PROGRESS_STORE)?;
    let mut state_guard = state.lock().unwrap();
    book_open(&mut state_guard, &path)?;
    post_book_open(&window, &state_guard)?;
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
) -> CmdResult<(SpineItem, Option<f64>)> {
    log::debug!("command open_epub[{}]", path.to_string_lossy());
    open_epub_impl(window, state, path)
}

#[tauri::command]
fn reload_book(
    app_handle: AppHandle,
    window: Window,
    state: State<AppState>,
) -> CmdResult<(SpineItem, Option<f64>)> {
    log::debug!("command reload_book");
    let path = {
        let state_guard = state.lock().unwrap();
        state_guard.book_file_info.path.clone()
    };

    let prefs_store = app_handle.store(PREFS_STORE)?;
    prefs_store.reload()?;
    cache_prefs_in_state(state.lock().as_mut().unwrap(), &prefs_store)?;

    open_epub_impl(window, state, path)
}

#[tauri::command]
fn open_epub_if_loaded(
    window: Window,
    state: State<AppState>,
) -> CmdResult<Option<(SpineItem, Option<f64>)>> {
    log::debug!("command open_epub_if_loaded");
    let opened = post_book_open(&window, &state.lock().unwrap())?;
    if !opened {
        log::debug!("no book was loaded");
        return Ok(None);
    }

    let mut state_guard = state.lock().unwrap();
    post_book_open(&window, &state_guard)?;
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
        .menu(|handle| menus::make(handle))
        .on_menu_event(|handle, event| {
            let id = event.id().0.as_str();
            if let Err(err) = menus::handle_menu_event(handle, id) {
                log::error!("when handling menu event {}: {}", id, err);
            }
        })
        .setup(move |app| {
            log::debug!("setup");
            if let Some(filepath) = filepath {
                log::debug!(" with {}", filepath.to_string_lossy());
                let state = app.state::<AppState>();
                if let Err(err) = book_open(state.lock().as_mut().unwrap(), &filepath) {
                    log::error!("failed to open: {}", err);
                }
            }

            let state = app.state::<AppState>();
            let prefs_store = app.store(PREFS_STORE)?;
            cache_prefs_in_state(state.lock().as_mut().unwrap(), &prefs_store)?;

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
