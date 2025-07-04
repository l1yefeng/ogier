#[derive(Debug, thiserror::Error)]
pub enum AnyErr {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    // tauri
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    TauriPluginOpener(#[from] tauri_plugin_opener::Error),
    #[error(transparent)]
    TauriPluginStore(#[from] tauri_plugin_store::Error),
    // epub
    #[error(transparent)]
    Epub(#[from] crate::epub::EpubError),
    #[error("URL not found in EPUB")]
    EpubUrlNotFound(#[from] crate::epub::UrlNotFoundErr),
    #[error("EPUB content error")]
    EpubContent,
    #[error("EPUB navigation file is missing")]
    EpubNoNav,
    // else
    #[error("Unknown internal error")]
    Unknown,
}

impl serde::Serialize for AnyErr {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

impl<A: 'static, B: 'static> From<terrors::OneOf<(A, B)>> for AnyErr
where
    AnyErr: From<A>,
    AnyErr: From<B>,
{
    fn from(value: terrors::OneOf<(A, B)>) -> Self {
        match value.narrow::<A, _>() {
            Ok(a) => Self::from(a),
            Err(e) => match e.narrow::<B, _>() {
                Ok(b) => Self::from(b),
                _ => unreachable!(),
            },
        }
    }
}
