use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    TauriPluginOpener(#[from] tauri_plugin_opener::Error),
    #[error(transparent)]
    TauriPluginStore(#[from] tauri_plugin_store::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Epub(#[from] epub::doc::DocError),

    // FIXME: try harder
    #[error(transparent)]
    NotUtf8(#[from] std::string::FromUtf8Error),

    #[error("The given path cannot be found")]
    ResourcePathNotFound,

    #[error("The EPUB does not have TOC")]
    EpubHasNoToc,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
