pub mod package;

use std::{
    collections::HashMap,
    io::{BufReader, Error as IoError, Read, Seek},
};

use quick_xml::{Reader as XmlReader, errors::Error as XmlError, events::Event as XmlEvent};
use terrors::OneOf;
use zip::{ZipArchive, read::ZipFile, result::ZipError};

use package::{Error as PackageErr, Package};

#[derive(Debug, thiserror::Error)]
#[error("EPUB archive structure has issues")]
pub struct ArchiveErr;
#[derive(Debug, thiserror::Error)]
#[error("EPUB container file is missing or invalid")]
pub struct ContainerFileErr;

#[derive(Debug, thiserror::Error)]
pub enum EpubError {
    #[error(transparent)]
    Archive(#[from] ArchiveErr),
    #[error(transparent)]
    ContainerFile(#[from] ContainerFileErr),
    #[error(transparent)]
    PackageDoc(#[from] PackageErr),
    #[error("EPUB contains invalid href")]
    InvalidHref,
}

#[derive(Debug, thiserror::Error)]
#[error("No resource at given URL")]
pub struct UrlNotFoundErr;

pub struct EpubArchive<R: Read + Seek> {
    zip: ZipArchive<R>,
    zip_indexes: HashMap<url::Url, usize>,
}

impl<R: Read + Seek> EpubArchive<R> {
    fn new(reader: R, base_url: &url::Url) -> Result<Self, OneOf<(ArchiveErr, IoError)>> {
        let zip = ZipArchive::new(reader).map_err(|e| match e {
            ZipError::Io(e) => OneOf::new(e),
            _ => OneOf::new(ArchiveErr),
        })?;

        let mut zip_indexes = HashMap::new();
        for i in 0..zip.len() {
            if let Some(name) = zip.name_for_index(i) {
                let name = name.replace('\\', "/");
                if !name.ends_with('/') {
                    if let Ok(url) = base_url.join(&name) {
                        zip_indexes.insert(url, i);
                    }
                }
            }
        }

        Ok(Self { zip, zip_indexes })
    }

    /// The method to read a file in this archive.
    pub fn get_reader(
        &mut self,
        u: &url::Url,
    ) -> Result<ZipFile<'_, R>, OneOf<(IoError, UrlNotFoundErr)>> {
        let index = self.zip_indexes.get(u).ok_or(OneOf::new(UrlNotFoundErr))?;
        let entry = self.zip.by_index(*index).map_err(|e| match e {
            ZipError::Io(e) => OneOf::new(e),
            _ => panic!("Given index should exists in archive"),
        })?;
        Ok(entry)
    }
}

/// item reference in manifest and position in spine
struct ResourceIndex(usize, Option<usize>);

pub struct Epub {
    base_url: url::Url,
    version: package::Version,
    metadata: package::Metadata,
    resources: Vec<package::ResourceItem>,
    spine: Vec<usize>,
    resource_indexes: HashMap<url::Url, ResourceIndex>,
    legacy_toc: Option<usize>,
    legacy_cover: Option<usize>,
}

impl Epub {
    pub fn open<R: Read + Seek>(
        reader: R,
    ) -> Result<(Epub, EpubArchive<R>), OneOf<(EpubError, IoError)>> {
        let base_url = url::Url::parse("epub:/").unwrap();

        let mut archive = EpubArchive::new(reader, &base_url).map_err(|e| match e.narrow() {
            Ok(ae) => OneOf::new(EpubError::Archive(ae)),
            Err(e) => e.broaden(),
        })?;

        let localize_url_err = |becomes: EpubError| {
            |e: OneOf<(IoError, UrlNotFoundErr)>| {
                e.narrow::<UrlNotFoundErr, _>()
                    .map_or_else(|e| e.broaden(), |_| OneOf::new(becomes))
            }
        };

        // parse container file
        let container_file = {
            let u = base_url
                .join("META-INF/container.xml")
                .expect("epub:/META-INF/container.xml");
            archive
                .get_reader(&u)
                .map_err(localize_url_err(EpubError::from(ContainerFileErr)))?
        };
        let package_doc_url =
            parse_container_file(&base_url, container_file).map_err(|e| match e.narrow() {
                Ok(ce) => OneOf::new(EpubError::ContainerFile(ce)),
                Err(e) => e.broaden(),
            })?;

        // parse package document
        let package_doc = archive
            .get_reader(&package_doc_url)
            .map_err(localize_url_err(EpubError::from(PackageErr::Generic)))?;
        let mut package = Package::new(package_doc).map_err(|e| match e.narrow() {
            Ok(pe) => OneOf::new(EpubError::PackageDoc(pe)),
            Err(e) => e.broaden(),
        })?;

        let legacy_toc_id = package.spine.toc.as_ref();
        let legacy_cover_id = package
            .metadata
            .iter()
            .find(|item| item.property == "cover")
            .map(|item| item.value.clone().into_bytes().into_boxed_slice());
        let mut legacy_toc = None;
        let mut legacy_cover = None;

        // build resource indexes
        let mut resources = Vec::new();
        let mut resource_indexes = HashMap::new();
        let mut spine = Vec::new();
        for itemref in &package.spine.itemrefs {
            let item = package
                .manifest
                .remove(&itemref.idref)
                .ok_or(OneOf::new(EpubError::from(PackageErr::Spine)))?;
            let key = package_doc_url
                .join(&item.href)
                .map_err(|_| OneOf::new(EpubError::InvalidHref))?;
            let ri = resources.len();
            let si = spine.len();
            spine.push(ri);
            resources.push(item);
            resource_indexes.insert(key, ResourceIndex(ri, Some(si)));
            if legacy_toc_id.is_some_and(|id| *id == itemref.idref) {
                legacy_toc = Some(ri);
            }
            if legacy_cover_id
                .as_ref()
                .is_some_and(|id| *id == itemref.idref)
            {
                legacy_cover = Some(ri);
            }
        }
        for item in package.manifest.into_values() {
            let key = package_doc_url
                .join(&item.href)
                .map_err(|_| OneOf::new(EpubError::InvalidHref))?;
            let ri = resources.len();
            spine.push(ri);
            resources.push(item);
            resource_indexes.insert(key, ResourceIndex(ri, None));
        }

        let epub = Epub {
            base_url,
            version: package.version,
            metadata: package.metadata,
            resources,
            spine,
            resource_indexes,
            legacy_toc,
            legacy_cover,
        };
        Ok((epub, archive))
    }

    pub fn navigate_from(
        &self,
        current: &url::Url,
        forward: bool,
    ) -> Result<Option<&package::ResourceItem>, UrlNotFoundErr> {
        let Some(ResourceIndex(_ri, si)) = self.resource_indexes.get(current) else {
            return Err(UrlNotFoundErr);
        };
        let Some(si) = si.clone() else {
            // not in spine
            return Ok(None);
        };
        let si = if forward {
            if si == self.spine.len() - 1 {
                return Ok(None);
            }
            si + 1
        } else {
            if si == 0 {
                return Ok(None);
            }
            si - 1
        };
        let ri = self.spine[si];
        Ok(Some(&self.resources[ri]))
    }

    /// Returns the content document item the navigation arrives at, and
    /// whether this item is in the spine.
    pub fn navigate_to(
        &self,
        dest: &url::Url,
    ) -> Result<(&package::ResourceItem, bool), UrlNotFoundErr> {
        let Some(ResourceIndex(ri, si)) = self.resource_indexes.get(dest) else {
            return Err(UrlNotFoundErr);
        };
        Ok((&self.resources[*ri], si.is_some()))
    }

    pub fn navigate_to_start(&self) -> &package::ResourceItem {
        // TODO proper landing page
        &self.resources[0]
    }

    pub fn metadata(&self) -> &package::Metadata {
        &self.metadata
    }

    pub fn resource(&self, u: &url::Url) -> Result<&package::ResourceItem, UrlNotFoundErr> {
        self.resource_indexes
            .get(u)
            .map(|ResourceIndex(ri, _si)| &self.resources[*ri])
            .ok_or(UrlNotFoundErr)
    }

    pub fn title(&self) -> Option<&package::MetadataItem> {
        self.metadata.iter().find(|item| item.property == "title")
    }

    pub fn cover(&self) -> Option<&package::ResourceItem> {
        if self.version == package::Version::Epub3_0 {
            if let Some(item) = self.resources.iter().find(|item| {
                item.properties
                    .as_ref()
                    .is_some_and(|value| value.has("cover-image"))
            }) {
                return Some(item);
            }
        }

        self.legacy_cover.map(|ri| &self.resources[ri])
    }

    pub fn nav(&self) -> Option<&package::ResourceItem> {
        match self.version {
            package::Version::Epub3_0 => self.resources.iter().find(|item| {
                item.properties
                    .as_ref()
                    .is_some_and(|value| value.has("nav"))
            }),
            package::Version::Epub2_0 => None,
        }
    }
}

/// Parse container.xml (read by `reader`). Returns the root package document's uri.
fn parse_container_file<R: Read>(
    base_url: &url::Url,
    reader: R,
) -> Result<url::Url, OneOf<(ContainerFileErr, IoError)>> {
    let mut xml_reader = XmlReader::from_reader(BufReader::new(reader));
    let mut buf = Vec::new();
    loop {
        let evt = xml_reader.read_event_into(&mut buf).map_err(|e| match e {
            XmlError::Io(e) => OneOf::new(IoError::from(e.kind())),
            _ => OneOf::new(ContainerFileErr),
        })?;
        match evt {
            XmlEvent::Eof => break,

            XmlEvent::Start(e) | XmlEvent::Empty(e) if e.local_name().as_ref() == b"rootfile" => {
                let Ok(Some(path)) = e.try_get_attribute(b"full-path") else {
                    break;
                };
                let Ok(path) = path.decode_and_unescape_value(xml_reader.decoder()) else {
                    break;
                };
                let Ok(uri) = base_url.join(&path) else {
                    break;
                };
                return Ok(uri);
            }

            _ => {}
        }
    }
    Err(OneOf::new(ContainerFileErr))
}

// TODO: check the use of id and if # is optional

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_parse_container_xml() {
        let base_url = url::Url::parse("epub:/").unwrap();
        let xml = r#"
            <?xml version="1.0"?>
            <container
                version="1.0"
                xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                <rootfiles>
                    <rootfile
                        full-path="EPUB/As_You_Like_It.opf"
                        media-type="application/oebps-package+xml"/>
                </rootfiles>
            </container>
        "#;
        let reader = xml.as_bytes();
        let package_doc_uri = parse_container_file(&base_url, reader).unwrap();
        let expected = url::Url::parse("epub:/EPUB/As_You_Like_It.opf").unwrap();
        assert_eq!(expected, package_doc_uri);
    }

    const EPUB3_PATH: &str = "src/testing/descartes.epub";

    #[test]
    fn test_epub3_opens() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(EPUB3_PATH);
        let file = std::fs::File::open(path).expect("Failed to open file");
        let (epub, _) = Epub::open(BufReader::new(file)).expect("Failed to open EPUB");

        assert_eq!(package::Version::Epub3_0, epub.version);

        let title_data = epub.title().expect("Failed to recognize title");
        assert_eq!(String::from("Philosophical Works"), title_data.value);
    }

    #[test]
    fn test_epub3_read_nav() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(EPUB3_PATH);
        let file = std::fs::File::open(path).expect("Failed to open file");
        let (epub, mut archive) = Epub::open(BufReader::new(file)).expect("Failed to open EPUB");

        let nav = epub.nav().expect("Failed to recognize nav document");
        assert_eq!(String::from("application/xhtml+xml"), nav.media_type);

        // let mut nav = archive.get_reader(&nav.url).unwrap();
        // let mut nav_content = String::new();
        // nav.read_to_string(&mut nav_content).unwrap();

        // assert!(nav_content.contains("epub:type=\"toc\""));
    }

    #[test]
    fn test_epub3_spine() {
        // let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(EPUB3_PATH);
        // let file = std::fs::File::open(path).expect("Failed to open file");
        // let (epub, _) = Epub::open(BufReader::new(file)).expect("Failed to open EPUB");

        // let mut page = Some(epub.navigate_to_start());

        // // forward
        // for _ in 0..99 {
        //     match page {
        //         Some(p) => page = epub.navigate_from(&p.url, true).unwrap(),
        //         None => break,
        //     }
        // }
        // // there's a problem if still navigating after 99 iterations.
        // assert!(page.is_none());
    }

    #[test]
    fn test_url_in_epub() {
        use url::Url;

        let root = Url::parse("epub:/").unwrap();
        let join = |u: &Url, with| u.join(with).unwrap();

        assert_eq!(root, join(&root, "/"));
        assert_eq!(root, join(&root, ".."));
        assert_eq!(
            join(&root, "text/a.css"),
            join(&join(&root, "text/a.html"), "a.css")
        );
        assert_eq!(
            join(&root, "nav.html"),
            join(&join(&root, "text/a.html"), "../nav.html")
        );
        assert_eq!(
            join(&root, "text/a.css"),
            join(&join(&root, "text/a.html"), "/text/a.css")
        );
    }
}
