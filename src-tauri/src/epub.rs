use std::{
    borrow::Cow,
    collections::HashMap,
    io::{BufReader, Error as IoError, Read, Seek},
};

use quick_xml::{
    NsReader as XmlNsReader, Reader as XmlReader, errors::Error as XmlError,
    events::Event as XmlEvent,
};
use terrors::OneOf;
use zip::{ZipArchive, read::ZipFile, result::ZipError};

#[derive(Debug, thiserror::Error)]
#[error("EPUB archive structure has issues")]
pub struct ArchiveErr;
#[derive(Debug, thiserror::Error)]
#[error("EPUB container file is missing or invalid")]
pub struct ContainerFileErr;
#[derive(Debug, thiserror::Error)]
pub enum PackageDocErr {
    #[error("EPUB package document is missing or invalid")]
    Generic,
    #[error("EPUB package document has invalid manifest")]
    Manifest,
    #[error("EPUB package document has invalid spine")]
    Spine,
}

#[derive(Debug, thiserror::Error)]
pub enum EpubError {
    #[error(transparent)]
    Archive(#[from] ArchiveErr),
    #[error(transparent)]
    ContainerFile(#[from] ContainerFileErr),
    #[error(transparent)]
    PackageDoc(#[from] PackageDocErr),
}

#[derive(Debug, thiserror::Error)]
#[error("No resource at given URL")]
pub struct UrlNotFoundErr;

type Id = String;

/// An EPUB3 metadata subexpression.
/// It is associated with another metadata expression.
/// The design follows EPUB3 but can be approximated when facing EPUB2 using attributes.
#[derive(Clone, Debug, serde::Serialize)]
struct MetadataRefinement {
    pub property: String,
    pub value: String,
    pub lang: Option<String>,
    pub scheme: Option<String>,
}

/// An EPUB3 Dublin Core metadata item.
/// The design follows EPUB3's dcterms element but can draw information both
/// dcterms and primary `<meta>` expressions.
///
/// When facing EPUB2, it also draws information from XHTML1.1 `<meta>`.
#[derive(Clone, Debug, serde::Serialize)]
pub struct MetadataItem {
    pub id: Option<Id>,
    pub property: String,
    pub value: String,
    pub lang: Option<String>,
    pub refined: Vec<MetadataRefinement>,
}

/// `<package><metadata>`
pub type Metadata = Vec<MetadataItem>;

/// `<package><manifest><item>`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceItem {
    pub url: url::Url,
    pub media_type: String,
    pub properties: Option<String>,
}

/// `<package><manifest>`
type Manifest = HashMap<Id, ResourceItem>;

/// `<package><spine>`
#[derive(Default)]
struct Spine {
    /// Legacy feature in EPUB3. ID of the NCX resource.
    toc: Option<Id>,
    /// IDs of all resources in the spine, excluding linear=no items.
    itemrefs: Vec<Id>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Version {
    Epub2_0,
    Epub3_0,
}

/// `<package>` in EPUB, and not much more.
struct Package {
    version: Version,
    metadata: Metadata,
    manifest: Manifest,
    spine: Spine,
}

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
    version: Version,
    metadata: Metadata,
    resources: Vec<ResourceItem>,
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
            .map_err(localize_url_err(EpubError::from(PackageDocErr::Generic)))?;
        let mut package: Package = {
            let mut package_parser = PackageParser::new(&package_doc_url, package_doc);
            package_parser.parse().map_err(|e| match e.narrow() {
                Ok(pe) => OneOf::new(EpubError::PackageDoc(pe)),
                Err(e) => e.broaden(),
            })?;
            package_parser.into()
        };

        let legacy_toc_id = package.spine.toc.as_ref();
        let legacy_cover_id = package
            .metadata
            .iter()
            .find(|item| item.property == "cover")
            .map(|item| &item.value);
        let mut legacy_toc = None;
        let mut legacy_cover = None;

        // build resource indexes
        let mut resources = Vec::new();
        let mut resource_indexes = HashMap::new();
        let mut spine = Vec::new();
        for itemref in &package.spine.itemrefs {
            let item = package
                .manifest
                .remove(itemref)
                .ok_or(OneOf::new(EpubError::from(PackageDocErr::Spine)))?;
            let key = item.url.clone();
            let ri = resources.len();
            let si = spine.len();
            spine.push(ri);
            resources.push(item);
            resource_indexes.insert(key, ResourceIndex(ri, Some(si)));
            if legacy_toc_id.is_some_and(|id| id == itemref) {
                legacy_toc = Some(ri);
            }
            if legacy_cover_id.is_some_and(|id| id == itemref) {
                legacy_cover = Some(ri);
            }
        }
        for item in package.manifest.into_values() {
            let key = item.url.clone();
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
    ) -> Result<Option<&ResourceItem>, UrlNotFoundErr> {
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
    pub fn navigate_to(&self, dest: &url::Url) -> Result<(&ResourceItem, bool), UrlNotFoundErr> {
        let Some(ResourceIndex(ri, si)) = self.resource_indexes.get(dest) else {
            return Err(UrlNotFoundErr);
        };
        Ok((&self.resources[*ri], si.is_some()))
    }

    pub fn navigate_to_start(&self) -> &ResourceItem {
        // TODO proper landing page
        &self.resources[0]
    }

    pub fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    pub fn resource(&self, u: &url::Url) -> Result<&ResourceItem, UrlNotFoundErr> {
        self.resource_indexes
            .get(u)
            .map(|ResourceIndex(ri, _si)| &self.resources[*ri])
            .ok_or(UrlNotFoundErr)
    }

    pub fn title(&self) -> Option<&MetadataItem> {
        self.metadata.iter().find(|item| item.property == "title")
    }

    pub fn cover(&self) -> Option<&ResourceItem> {
        if let Version::Epub3_0 = self.version {
            if let Some(item) = self.resources.iter().find(|item| {
                item.properties
                    .as_ref()
                    .is_some_and(|value| value.split(' ').any(|p| p == "cover-image"))
            }) {
                return Some(item);
            }
        }

        self.legacy_cover.map(|ri| &self.resources[ri])
    }

    pub fn nav(&self) -> Option<&ResourceItem> {
        match self.version {
            Version::Epub3_0 => self.resources.iter().find(|item| {
                item.properties
                    .as_ref()
                    .is_some_and(|value| value.split(' ').any(|p| p == "nav"))
            }),
            Version::Epub2_0 => None,
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

struct PackageParser<'a, R: Read> {
    base_url: &'a url::Url,
    reader: XmlNsReader<BufReader<R>>,
    buf: Vec<u8>,
    out: Package,
}

impl<'a, R: Read> PackageParser<'a, R> {
    /// Create a parser. `reader` doesn't need to be buffered.
    fn new(base_url: &'a url::Url, reader: R) -> Self {
        let mut xml_reader = XmlNsReader::from_reader(BufReader::new(reader));
        let config = xml_reader.config_mut();
        config.trim_text(true);
        config.check_end_names = true;
        Self {
            base_url,
            reader: xml_reader,
            buf: Vec::new(),
            out: Package {
                version: Version::Epub2_0,
                metadata: Vec::new(),
                manifest: HashMap::new(),
                spine: Spine::default(),
            },
        }
    }

    fn map_xml_err(e: XmlError) -> OneOf<(PackageDocErr, IoError)> {
        match e {
            XmlError::Io(e) => OneOf::new(IoError::from(e.kind())),
            _ => OneOf::new(PackageDocErr::Generic),
        }
    }

    fn parse(&mut self) -> Result<(), OneOf<(PackageDocErr, IoError)>> {
        loop {
            match self
                .reader
                .read_event_into(&mut self.buf)
                .map_err(Self::map_xml_err)?
            {
                // <package>
                XmlEvent::Start(e) if e.local_name().as_ref() == b"package" => {
                    // obtain version
                    let Ok(Some(ver)) = e.try_get_attribute(b"version") else {
                        return Err(OneOf::new(PackageDocErr::Generic));
                    };
                    self.out.version = if ver.value.eq_ignore_ascii_case(b"3.0") {
                        Version::Epub3_0
                    } else {
                        Version::Epub2_0
                    };
                }
                XmlEvent::End(e) if e.local_name().as_ref() == b"package" => {
                    return Ok(());
                }

                // <metadata>
                XmlEvent::Start(e) if e.local_name().as_ref() == b"metadata" => {
                    self.out.metadata = self.parse_metadata().map_err(Self::map_xml_err)?;
                }
                // <manifest>
                XmlEvent::Start(e) if e.local_name().as_ref() == b"manifest" => {
                    self.out.manifest =
                        self.parse_manifest()
                            .map_err(|e| match e.narrow::<XmlError, _>() {
                                Ok(xe) => Self::map_xml_err(xe),
                                Err(e) => match e.narrow::<url::ParseError, _>() {
                                    Ok(_) => OneOf::new(PackageDocErr::Manifest),
                                    Err(e) => e.broaden(),
                                },
                            })?;
                }
                // <spine>
                XmlEvent::Start(e) if e.local_name().as_ref() == b"spine" => {
                    let toc = Self::get_attribute(&e, b"toc", self.reader.decoder())
                        .map_err(|_| OneOf::new(PackageDocErr::Generic))?;
                    self.out.spine.toc = toc.map(String::from);
                    self.out.spine.itemrefs =
                        self.parse_spine()
                            .map_err(|e| match e.narrow::<XmlError, _>() {
                                Ok(xe) => Self::map_xml_err(xe),
                                Err(e) => e.broaden(),
                            })?;
                }

                _ => {}
            }
        }
    }

    fn parse_metadata(&mut self) -> Result<Metadata, XmlError> {
        // FIXME e.g., description can have rich content, not simply text
        // TODO don't use String::from_utf8_lossy
        use quick_xml::name::{Namespace, ResolveResult::Bound};

        enum LastValue {
            Metadata,
            Refinement(Id),
        }

        // parse metadata.
        // starting from the next event, find all metadata items.
        // stop after reading the closing tag.
        let mut metadata: Metadata = Vec::new();
        let mut refinements: HashMap<Id, Vec<MetadataRefinement>> = HashMap::new();

        // collect items to out.metadata in the loop.
        // collect refinements to vec.
        let decoder = self.reader.decoder();
        let legacy = self.out.version == Version::Epub2_0;
        let mut last_value_pending_state = None::<LastValue>;
        loop {
            match self.reader.read_resolved_event_into(&mut self.buf)? {
                (_, XmlEvent::Eof) => break,
                (_, XmlEvent::End(e)) if e.local_name().as_ref() == b"metadata" => break,

                (_, XmlEvent::Text(e)) if last_value_pending_state.is_some() => {
                    let value = String::from_utf8_lossy(e.as_ref()).into();
                    match last_value_pending_state.take().unwrap() {
                        LastValue::Metadata => metadata.last_mut().unwrap().value = value,
                        LastValue::Refinement(id) => {
                            refinements.get_mut(&id).unwrap().last_mut().unwrap().value = value
                        }
                    }
                }

                (Bound(Namespace(b"http://purl.org/dc/elements/1.1/")), XmlEvent::Start(e)) => {
                    // <dc:___>, i.e., dublin core. e.g., dc:title
                    let mut id = None;
                    let mut lang = None;
                    let property = String::from_utf8_lossy(e.local_name().as_ref()).into();
                    let mut refined = Vec::new();
                    for attr in e.attributes().filter_map(|attr| attr.map_or(None, Some)) {
                        if attr.key.local_name().as_ref() == b"id" {
                            id = Some(attr.decode_and_unescape_value(decoder)?.into());
                        } else if attr.key.local_name().as_ref() == b"lang" {
                            lang = Some(attr.decode_and_unescape_value(decoder)?.into());
                        } else if legacy {
                            if let (Bound(Namespace(b"http://www.idpf.org/2007/opf")), local) =
                                self.reader.resolve_attribute(attr.key)
                            {
                                let property = String::from_utf8_lossy(local.as_ref());
                                let value = attr.decode_and_unescape_value(decoder)?;
                                refined.push(MetadataRefinement {
                                    property: property.into(),
                                    value: value.into(),
                                    lang: None,
                                    scheme: None,
                                });
                            }
                        }
                    }

                    metadata.push(MetadataItem {
                        id,
                        property,
                        value: String::new(),
                        lang,
                        refined,
                    });
                    last_value_pending_state = Some(LastValue::Metadata);
                }

                (Bound(Namespace(b"http://www.idpf.org/2007/opf")), XmlEvent::Start(e))
                    if e.local_name().as_ref() == b"meta" =>
                {
                    if let Some(property) = Self::get_attribute(&e, b"property", decoder)? {
                        let lang = Self::get_attribute(&e, b"xml:lang", decoder)?;

                        if let Some(refines) = Self::get_attribute(&e, b"refines", decoder)? {
                            // subexpression
                            let refines = refines.strip_prefix('#').unwrap_or_else(|| &refines);
                            let scheme = Self::get_attribute(&e, b"scheme", decoder)?;
                            let refinement = MetadataRefinement {
                                property: property.into(),
                                value: String::new(), // tbd
                                lang: lang.map(String::from),
                                scheme: scheme.map(String::from),
                            };
                            // push to refinements
                            if !refinements.contains_key(refines) {
                                refinements.insert(refines.into(), Vec::new());
                            }
                            refinements.get_mut(refines).unwrap().push(refinement);
                            last_value_pending_state = Some(LastValue::Refinement(refines.into()));
                        } else {
                            // primary expression
                            let id = Self::get_attribute(&e, b"id", decoder)?;
                            metadata.push(MetadataItem {
                                id: id.map(Id::from),
                                property: property.into(),
                                value: String::new(), // tbd
                                lang: lang.map(String::from),
                                refined: vec![],
                            });
                            last_value_pending_state = Some(LastValue::Metadata);
                        }
                    }
                }

                (_, XmlEvent::Empty(e)) if e.local_name().as_ref() == b"meta" => {
                    // legacy XHTML1.1 <meta>
                    if let (Some(name), Some(content)) = (
                        Self::get_attribute(&e, b"name", decoder)?,
                        Self::get_attribute(&e, b"content", decoder)?,
                    ) {
                        metadata.push(MetadataItem {
                            id: None,
                            property: name.into(),
                            value: content.into(),
                            lang: None,
                            refined: vec![],
                        });
                    }
                }

                _ => {}
            }
        }

        // insert refinements to out.metadata
        for item in metadata.iter_mut() {
            let Some(id) = item.id.as_ref() else {
                continue;
            };
            let Some(mut refs) = refinements.remove(id) else {
                continue;
            };
            item.refined.append(&mut refs);
        }

        Ok(metadata)
    }

    fn parse_manifest(
        &mut self,
    ) -> Result<Manifest, OneOf<(PackageDocErr, url::ParseError, XmlError)>> {
        let mut manifest: Manifest = HashMap::new();

        let decoder = self.reader.decoder();
        loop {
            match self
                .reader
                .read_event_into(&mut self.buf)
                .map_err(OneOf::new)?
            {
                XmlEvent::Eof => break,
                XmlEvent::End(e) if e.local_name().as_ref() == b"manifest" => break,

                XmlEvent::Empty(e) if e.local_name().as_ref() == b"item" => {
                    let id = Self::get_attribute(&e, b"id", decoder).map_err(OneOf::new)?;
                    let id = id.ok_or(OneOf::new(PackageDocErr::Manifest))?;
                    let href = Self::get_attribute(&e, b"href", decoder).map_err(OneOf::new)?;
                    let href = href.ok_or(OneOf::new(PackageDocErr::Manifest))?;
                    let url = self.base_url.join(&href).map_err(OneOf::new)?;
                    let media_type =
                        Self::get_attribute(&e, b"media-type", decoder).map_err(OneOf::new)?;
                    let media_type = media_type.ok_or(OneOf::new(PackageDocErr::Manifest))?;
                    let properties =
                        Self::get_attribute(&e, b"properties", decoder).map_err(OneOf::new)?;
                    manifest.insert(
                        id.into(),
                        ResourceItem {
                            url,
                            media_type: media_type.into(),
                            properties: properties.map(String::from),
                        },
                    );
                }

                _ => {}
            }
        }

        Ok(manifest)
    }

    fn parse_spine(&mut self) -> Result<Vec<Id>, OneOf<(PackageDocErr, XmlError)>> {
        let mut itemrefs = Vec::new();

        let decoder = self.reader.decoder();
        loop {
            match self
                .reader
                .read_event_into(&mut self.buf)
                .map_err(OneOf::new)?
            {
                XmlEvent::Eof => break,
                XmlEvent::End(e) if e.local_name().as_ref() == b"spine" => break,

                XmlEvent::Empty(e) if e.local_name().as_ref() == b"itemref" => {
                    let idref = Self::get_attribute(&e, b"idref", decoder).map_err(OneOf::new)?;
                    let idref = idref.ok_or(OneOf::new(PackageDocErr::Spine))?;
                    itemrefs.push(idref.into());
                }

                _ => {}
            }
        }

        Ok(itemrefs)
    }

    fn get_attribute<'attr, N: AsRef<[u8]> + Sized>(
        start: &'attr quick_xml::events::BytesStart,
        name: N,
        decoder: quick_xml::Decoder,
    ) -> Result<Option<Cow<'attr, str>>, XmlError> {
        start
            .try_get_attribute(name)?
            .map(|a| a.decode_and_unescape_value(decoder))
            .map_or(Ok(None), |a| a.map(Some))
    }
}

impl<'a, R: Read> Into<Package> for PackageParser<'a, R> {
    fn into(self) -> Package {
        self.out
    }
}

// TODO: check the use of id and if # is optional

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_parse_package_version() {
        let base_url = url::Url::parse("epub:/").unwrap();
        let xml = r#"
            <?xml version="1.0"?>
            <package
                version="3.0"
                xml:lang="en"
                xmlns="http://www.idpf.org/2007/opf"
                unique-identifier="pub-id">

               <metadata
                   xmlns:dc="http://purl.org/dc/elements/1.1/">

               </metadata>
            </package>
        "#;
        let reader = xml.as_bytes();
        let mut parser = PackageParser::new(&base_url, reader);
        parser.parse().unwrap();
        let package: Package = parser.into();
        assert_eq!(Version::Epub3_0, package.version);
    }

    #[test]
    fn test_parse_package_metadata() {
        let base_url = url::Url::parse("epub:/").unwrap();
        let xml = include_bytes!("testing/metadata.opf");
        let mut parser = PackageParser::new(&base_url, xml.as_slice());
        parser.parse().unwrap();
        let package: Package = parser.into();
        let expected = include_str!("testing/metadata.json")
            .strip_suffix('\n')
            .unwrap();
        assert_eq!(
            expected,
            serde_json::to_string_pretty(&package.metadata).unwrap()
        );
    }

    #[test]
    fn test_parse_package_manifest_and_spine() {
        let base_url = url::Url::parse("epub:/EPUB/As_You_Like_It.opf").unwrap();
        let xml = r#"
            <?xml version="1.0"?>
            <package
                version="3.0"
                xml:lang="en"
                xmlns="http://www.idpf.org/2007/opf"
                unique-identifier="pub-id">

               <metadata
                   xmlns:dc="http://purl.org/dc/elements/1.1/">
               </metadata>

               <manifest>
                  <item id="r4915"
                      href="book.html"
                      media-type="application/xhtml+xml"/>
                  <item id="r7184"
                      href="images/cover.png"
                      media-type="image/png"/>
                  <item id="nav"
                      href="nav.html"
                      media-type="application/xhtml+xml"
                      properties="nav"/>
               </manifest>

               <spine>
                  <itemref
                      idref="r4915"/>
               </spine>

            </package>
        "#;
        let reader = xml.as_bytes();
        let mut parser = PackageParser::new(&base_url, reader);
        parser.parse().unwrap();
        let package: Package = parser.into();
        {
            let manifest = &package.manifest;
            assert_eq!(3, manifest.len());
            assert_eq!(
                ResourceItem {
                    url: url::Url::parse("epub:/EPUB/book.html").unwrap(),
                    media_type: "application/xhtml+xml".into(),
                    properties: None
                },
                manifest["r4915"]
            );
            assert_eq!(
                ResourceItem {
                    url: url::Url::parse("epub:/EPUB/images/cover.png").unwrap(),
                    media_type: "image/png".into(),
                    properties: None
                },
                manifest["r7184"]
            );
            assert_eq!(
                ResourceItem {
                    url: url::Url::parse("epub:/EPUB/nav.html").unwrap(),
                    media_type: "application/xhtml+xml".into(),
                    properties: Some("nav".into())
                },
                manifest["nav"]
            );
        }
        {
            let spine = &package.spine;
            assert_eq!(None, spine.toc);
            assert_eq!(vec![String::from("r4915")], spine.itemrefs);
        }
    }
}
