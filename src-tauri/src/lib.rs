mod alter;
mod epub;
mod errors;
mod menus;
mod prefs;

use std::fs::File;
use std::hash::Hasher;
use std::io::{BufReader, Error as IoError, Read};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State, Window, http};
use tauri_plugin_store::{StoreExt, resolve_store_path};
use twox_hash::XxHash64;
use url::Url;

use alter::{alter_css, alter_xhtml};
use epub::Epub;
use errors::AnyErr;

type EpubArchive = epub::EpubArchive<BufReader<File>>;
type EpubHash = arrayvec::ArrayString<16>;

#[derive(serde::Serialize)]
struct AboutPub {
    // file
    #[serde(rename(serialize = "filePath"))]
    pub file_path: PathBuf,
    #[serde(rename(serialize = "fileSize"))]
    pub file_size: u64,
    #[serde(rename(serialize = "fileCreated"))]
    pub file_created: u128,
    #[serde(rename(serialize = "fileModified"))]
    pub file_modified: u128,
    // epub
    #[serde(rename(serialize = "pubMetadata"))]
    pub pub_metadata: epub::package::Metadata,
    #[serde(rename(serialize = "pubSpine"))]
    pub pub_spine: Vec<Url>,
    #[serde(rename(serialize = "pubCoverUrl"))]
    pub pub_cover_url: Option<Url>,
    #[serde(rename(serialize = "pubTocUrl"))]
    pub pub_toc_url: Option<Url>,
    #[serde(rename(serialize = "pubTocIsLegacy"))]
    pub pub_toc_is_legacy: bool,
    #[serde(rename(serialize = "pubLandingPage"))]
    pub pub_landing_page: Url,
}

struct AppOpenedEpub {
    path: PathBuf,
    pb: Epub,
    archive: EpubArchive,
    hash: EpubHash,
}

impl TryFrom<&AppOpenedEpub> for AboutPub {
    type Error = AnyErr;

    fn try_from(opened: &AppOpenedEpub) -> Result<Self, Self::Error> {
        let AppOpenedEpub { path, pb, .. } = opened;

        let file_metadata = std::fs::metadata(path)?;
        let as_ms = |time: SystemTime| {
            time.duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        };

        // about toc
        let mut pub_toc_is_legacy = false;
        let pub_toc_url = match pb.nav() {
            Some(u) => Some(u.clone()),
            None => {
                pub_toc_is_legacy = true;
                pb.legacy_toc().clone()
            }
        };

        let about = AboutPub {
            file_path: path.clone(),
            file_size: file_metadata.len(),
            file_created: file_metadata.created().map(as_ms).unwrap_or_default(),
            file_modified: file_metadata.modified().map(as_ms).unwrap_or_default(),
            pub_metadata: pb.metadata().clone(),
            pub_spine: pb.spine().clone(),
            pub_cover_url: pb.cover().cloned(),
            pub_toc_url,
            pub_toc_is_legacy,
            pub_landing_page: pb.first_page_to_open().clone(),
        };
        log::debug!(
            "AboutPub: {}",
            serde_json::to_string_pretty(&about).unwrap()
        );

        Ok(about)
    }
}

#[derive(Default)]
struct AppData {
    opened_pub: Option<AppOpenedEpub>,
    setup_err: Option<AnyErr>,
}

type AppState = Mutex<AppData>;

const PROGRESS_STORE: &str = "progress.json";
const PREFS_STORE: &str = "prefs.json";

pub const MIMETYPE_XHTML: &str = "application/xhtml+xml";
pub const MIMETYPE_SVG: &str = "image/svg+xml";
pub const MIMETYPE_CSS: &str = "text/css";

struct BytesAndMediaType(Vec<u8>, String);

/// The same file produces the same hash.
fn compute_file_hash(filepath: &PathBuf) -> Result<EpubHash, IoError> {
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

/// Do several things that are necessary when a book just opened.
fn post_book_open(window: &Window, state: &mut MutexGuard<'_, AppData>) -> Result<bool, AnyErr> {
    if let Some(setup_err) = state.setup_err.take() {
        return Err(setup_err);
    }

    let Some(opened) = &state.opened_pub else {
        return Ok(false);
    };

    // set window title with book title
    let title = match opened.pb.title() {
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
    let (pb, archive) = Epub::open(BufReader::new(file))?;

    let hash = compute_file_hash(&path)?;
    state.opened_pub = Some(AppOpenedEpub {
        path: path.clone(),
        pb,
        archive,
        hash,
    });

    log::debug!("book opened and info extracted");

    Ok(())
}

fn filewise_styles_path(
    app_handle: &AppHandle,
    state: &MutexGuard<'_, AppData>,
) -> Result<PathBuf, AnyErr> {
    let opened = state.opened_pub.as_ref().ok_or(AnyErr::Unknown)?;
    let mut path = resolve_store_path(app_handle, opened.hash)?;
    path.set_extension("json");
    Ok(path)
}

#[tauri::command]
fn get_filewise_styles(app_handle: AppHandle, state: State<AppState>) -> Result<String, AnyErr> {
    let path = {
        let state_guard = state.lock().unwrap();
        filewise_styles_path(&app_handle, &state_guard)?
    };
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
fn set_filewise_styles(
    app_handle: AppHandle,
    state: State<AppState>,
    content: String,
) -> Result<(), AnyErr> {
    let path = {
        let state_guard = state.lock().unwrap();
        filewise_styles_path(&app_handle, &state_guard)?
    };
    std::fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
fn set_reading_position(
    window: Window,
    state: State<AppState>,
    url: Url,
    percentage: f64,
) -> Result<(), AnyErr> {
    let progress_store = window.store(PROGRESS_STORE)?;

    let state_guard = state.lock().unwrap();
    let hash = &state_guard.opened_pub.as_ref().unwrap().hash;
    progress_store.set(hash.as_str(), serde_json::json!([url, percentage]));
    Ok(())
}

#[tauri::command]
fn get_reading_position(
    window: Window,
    state: State<AppState>,
) -> Result<Option<(Url, Option<f64>)>, AnyErr> {
    let progress_store = window.store(PROGRESS_STORE)?;

    let state_guard = state.lock().unwrap();
    let hash = &state_guard.opened_pub.as_ref().unwrap().hash;

    let Some(val) = progress_store.get(hash) else {
        return Ok(None);
    };
    let Ok(val) = serde_json::from_value(val) else {
        return Ok(None);
    };

    Ok(Some(val))
}

fn open_epub_impl(
    window: Window,
    state: State<AppState>,
    path: PathBuf,
) -> Result<AboutPub, AnyErr> {
    {
        let mut state_guard = state.lock().unwrap();
        book_open(&mut state_guard, &path)?;
        post_book_open(&window, &mut state_guard)?;
    }
    let state_guard = state.lock().unwrap();
    let opened = state_guard.opened_pub.as_ref().unwrap();
    AboutPub::try_from(opened)
}

/// Front-end invokes this to view EPUB at the given path.
///
/// Returns the current page and the reading position in page.
#[tauri::command]
fn open_epub(window: Window, state: State<AppState>, path: PathBuf) -> Result<AboutPub, AnyErr> {
    log::debug!("command open_epub[{}]", path.to_string_lossy());
    open_epub_impl(window, state, path)
}

#[tauri::command]
fn reload_book(window: Window, state: State<AppState>) -> Result<AboutPub, AnyErr> {
    log::debug!("command reload_book");
    let path = {
        let state_guard = state.lock().unwrap();
        let opened = state_guard.opened_pub.as_ref().ok_or(AnyErr::Unknown)?;
        opened.path.clone()
    };

    open_epub_impl(window, state, path)
}

#[tauri::command]
fn open_epub_if_loaded(window: Window, state: State<AppState>) -> Result<Option<AboutPub>, AnyErr> {
    log::debug!("command open_epub_if_loaded");
    {
        let mut state_guard = state.lock().unwrap();
        let exists = post_book_open(&window, &mut state_guard)?;
        if !exists {
            log::debug!("no book was loaded");
            return Ok(None);
        }
    }

    let state_guard = state.lock().unwrap();
    let opened = state_guard.opened_pub.as_ref().unwrap();
    AboutPub::try_from(opened).map(Some)
}

/// Convert the epub:// URL from `http::Uri` to `url::Url`.
fn url_from_epub_request(uri_in_request: &http::Uri) -> Result<url::Url, url::ParseError> {
    debug_assert_eq!(uri_in_request.scheme_str(), Some("epub"));
    let path = uri_in_request.path();
    debug_assert!(!path.starts_with("/localhost"));
    url::Url::parse("epub:/").and_then(|u| u.join(path))
}

fn serve_epub_request_body<R: Read>(
    mut zipfile: zip::read::ZipFile<'_, R>,
    media_type: &str,
    is_content_doc: bool,
) -> Result<Vec<u8>, AnyErr> {
    if is_content_doc {
        if media_type == MIMETYPE_XHTML {
            return alter_xhtml(zipfile);
        } else if media_type == MIMETYPE_SVG {
            // original
        } else {
            return Err(AnyErr::EpubContent);
        }
    } else if media_type == MIMETYPE_CSS {
        return alter_css(zipfile);
    }

    let mut buf = Vec::new();
    buf.reserve(zipfile.size() as usize);
    zipfile.read_to_end(&mut buf)?;
    Ok(buf)
}

fn serve_epub_request(
    app_handle: &AppHandle,
    uri: &Url,
    is_content_doc: bool,
) -> Result<BytesAndMediaType, http::StatusCode> {
    let state = app_handle.state::<AppState>();
    let mut state_guard = state.lock().unwrap();
    let opened = state_guard.opened_pub.as_mut().unwrap();

    let media_type = {
        let info = opened
            .pb
            .resource(uri)
            .map_err(|_| http::StatusCode::NOT_FOUND)?;
        info.media_type.clone()
    };

    let reader = opened
        .archive
        .get_reader(uri)
        .map_err(|e| match e.narrow() {
            Ok(epub::UrlNotFoundErr) => http::StatusCode::NOT_FOUND,
            _ => http::StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    let body =
        serve_epub_request_body(reader, &media_type, is_content_doc).map_err(|e| match e {
            AnyErr::EpubUrlNotFound(_) => http::StatusCode::NOT_FOUND,
            AnyErr::EpubContent => http::StatusCode::BAD_REQUEST,
            _ => http::StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    Ok(BytesAndMediaType(body, media_type))
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
        .register_uri_scheme_protocol("epub", |ctx, request| {
            let Ok(uri) = url_from_epub_request(request.uri()) else {
                return http::Response::builder()
                    .status(http::StatusCode::BAD_REQUEST)
                    .body(Vec::new())
                    .unwrap();
            };

            log::debug!("handling request {}", uri);

            let is_content_doc = request
                .headers()
                .get("Ogier-Epub-Content-Document")
                .is_some_and(|v| !v.is_empty());

            match serve_epub_request(ctx.app_handle(), &uri, is_content_doc) {
                Ok(BytesAndMediaType(body, mime)) => http::Response::builder()
                    .status(http::StatusCode::OK)
                    .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(http::header::CONTENT_TYPE, mime)
                    .body(body)
                    .unwrap(),
                Err(code) => http::Response::builder()
                    .status(code)
                    .body(Vec::default())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_filewise_styles,
            get_reading_position,
            open_epub,
            open_epub_if_loaded,
            reload_book,
            set_filewise_styles,
            set_reading_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
