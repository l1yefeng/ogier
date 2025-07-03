use crate::epub::Metadata;
use serde::Serialize;

#[derive(Serialize)]
pub enum EpubToc {
    Ncx { root: MyNavPoint },
    Nav { path: url::Url, xhtml: String },
}

#[derive(Serialize)]
pub struct MyNavPoint;

#[derive(Serialize)]
pub struct SpineItem {
    pub position: usize,
    pub path: url::Url,
    pub text: String,
    pub mimetype: String,
}

#[derive(Clone, Default, Serialize)]
pub struct EpubFileInfo {
    pub path: std::path::PathBuf,
    pub size: u64,
    pub created: u128,  // 0 if unavailable
    pub modified: u128, // 0 if unavailable
}

#[derive(Serialize)]
pub struct EpubDetails {
    #[serde(rename = "fileInfo")]
    pub file_info: EpubFileInfo,

    pub metadata: Metadata,
    #[serde(rename = "spineLength")]
    pub spine_length: usize,
    #[serde(rename = "displayTitle")]
    pub display_title: String, // empty if no title
    #[serde(rename = "coverBase64")]
    pub cover_base64: String, // empty if no cover
}
