use epub::doc::{MetadataItem, MetadataRefinement, NavPoint};
use serde::{Serialize, ser::SerializeStruct};

#[derive(Serialize)]
pub enum EpubToc {
    Ncx { root: MyNavPoint },
    Nav { path: String, xhtml: String },
}

pub struct MyNavPoint(pub NavPoint);

impl Serialize for MyNavPoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let it = &self.0;
        let mut state = serializer.serialize_struct("NavPoint", 4)?;
        state.serialize_field("label", &it.label)?;
        let mut content = it.content.to_string_lossy().to_string();
        if cfg!(windows) {
            content = content.replace('\\', "/");
        }
        state.serialize_field("content", &content)?;
        state.serialize_field("playOrder", &it.play_order)?;
        state.serialize_field(
            "children",
            &it.children
                .iter()
                .map(|p| MyNavPoint(p.clone()))
                .collect::<Vec<_>>(),
        )?;
        state.end()
    }
}

pub struct MyMetadataItem(pub MetadataItem);
pub struct MyMetadataRefinement(pub MetadataRefinement);

impl Serialize for MyMetadataItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let it = &self.0;
        let mut state = serializer.serialize_struct("MetadataItem", 4)?;
        state.serialize_field("property", &it.property)?;
        state.serialize_field("value", &it.value)?;
        state.serialize_field("lang", &it.lang)?;
        state.serialize_field(
            "refined",
            &it.refined
                .iter()
                .map(|r| MyMetadataRefinement(r.clone()))
                .collect::<Vec<_>>(),
        )?;
        state.end()
    }
}
impl Serialize for MyMetadataRefinement {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let it = &self.0;
        let mut state = serializer.serialize_struct("MetadataRefinement", 4)?;
        state.serialize_field("property", &it.property)?;
        state.serialize_field("value", &it.value)?;
        state.serialize_field("lang", &it.lang)?;
        state.serialize_field("scheme", &it.scheme)?;
        state.end()
    }
}

pub enum Navigation {
    Adjacent(bool),
    Position(usize),
}

#[derive(Serialize)]
pub struct SpineItem {
    pub position: usize,
    pub path: String,
    pub text: String,
    pub mimetype: String,
}

#[derive(Serialize, Clone)]
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

    pub metadata: Vec<MyMetadataItem>,
    #[serde(rename = "spineLength")]
    pub spine_length: usize,
    #[serde(rename = "displayTitle")]
    pub display_title: String, // empty if no title
    #[serde(rename = "coverBase64")]
    pub cover_base64: String, // empty if no cover
}
