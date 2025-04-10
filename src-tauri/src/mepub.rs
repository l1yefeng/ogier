use std::collections::HashMap;
use std::path::PathBuf;

use epub::doc::NavPoint;
use serde::{Serialize, ser::SerializeStruct};

pub struct MyNavPoint(pub NavPoint);

impl Serialize for MyNavPoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("NavPoint", 4)?;
        state.serialize_field("label", &self.0.label)?;
        state.serialize_field(
            "content",
            &self.0.content.to_string_lossy().replace('\\', "/"),
        )?;
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

pub enum Navigation {
    Adjacent(bool),
    Position(usize),
}

#[derive(Serialize)]
pub struct SpineItem {
    pub position: usize,
    pub path: PathBuf,
    pub text: String,
}

pub type Metadata = HashMap<String, Vec<String>>;

#[derive(Serialize, Clone)]
pub struct EpubFileInfo {
    pub path: PathBuf,
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
