use std::{
    borrow::Cow,
    collections::HashMap,
    io::{BufReader, Error as IoError, Read},
};

use quick_xml::{NsReader as XmlNsReader, errors::Error as XmlError, events::Event as XmlEvent};
use terrors::OneOf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("EPUB package document is missing or invalid")]
    Generic,
    #[error("EPUB package document has invalid manifest")]
    Manifest,
    #[error("EPUB package document has invalid spine")]
    Spine,
}

/// `<package>` in EPUB, and not much more.
pub struct Package {
    pub version: Version,
    pub metadata: Metadata,
    pub manifest: Manifest,
    pub spine: Spine,
}

impl Package {
    pub fn new<R: Read>(reader: R) -> Result<Self, OneOf<(Error, IoError)>> {
        let mut parser = PackageParser::new(reader);
        parser.parse()?;
        Ok(parser.out)
    }
}

/// Alias for IDs
pub type Id = Box<[u8]>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PropertiesValue(String);

impl PropertiesValue {
    pub fn has(&self, property: &str) -> bool {
        self.0.split(' ').find(|sub| *sub == property).is_some()
    }
}

/// An EPUB3 metadata subexpression.
/// It is associated with another metadata expression.
/// The design follows EPUB3 but can be approximated when facing EPUB2 using attributes.
#[derive(Clone, Debug, serde::Serialize)]
pub struct MetadataRefinement {
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
    #[serde(skip_serializing)]
    pub id: Option<Id>,
    pub property: String,
    pub value: String,
    pub lang: Option<String>,
    pub refined: Vec<MetadataRefinement>,
    pub legacy: bool,
}

/// `<package><metadata>`
pub type Metadata = Vec<MetadataItem>;

/// `<package><manifest><item>`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceItem {
    pub href: String,
    pub media_type: String,
    pub properties: Option<PropertiesValue>,
}

/// `<package><manifest>`
type Manifest = HashMap<Id, ResourceItem>;

/// `<package><spine><itemref>`
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Itemref {
    pub idref: Id,
    pub properties: Option<PropertiesValue>,
}

/// `<package><spine>`
#[derive(Default)]
pub struct Spine {
    /// Legacy feature in EPUB3. ID of the NCX resource.
    pub toc: Option<Id>,
    /// IDs of all resources in the spine, excluding linear=no items.
    pub itemrefs: Vec<Itemref>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Version {
    Epub2_0,
    Epub3_0,
}

struct PackageParser<R: Read> {
    reader: XmlNsReader<BufReader<R>>,
    buf: Vec<u8>,
    out: Package,
}

impl<R: Read> PackageParser<R> {
    /// Create a parser. `reader` doesn't need to be buffered.
    fn new(reader: R) -> Self {
        let mut xml_reader = XmlNsReader::from_reader(BufReader::new(reader));
        let config = xml_reader.config_mut();
        config.trim_text(true);
        config.check_end_names = true;
        Self {
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

    fn map_xml_err(e: XmlError) -> OneOf<(Error, IoError)> {
        match e {
            XmlError::Io(e) => OneOf::new(IoError::from(e.kind())),
            _ => OneOf::new(Error::Generic),
        }
    }

    fn parse(&mut self) -> Result<(), OneOf<(Error, IoError)>> {
        loop {
            match self
                .reader
                .read_event_into(&mut self.buf)
                .map_err(Self::map_xml_err)?
            {
                // <package>
                XmlEvent::Start(e) if e.local_name().as_ref() == b"package" => {
                    // obtain version
                    let Ok(Some(ver)) = Self::get_attribute(&e, b"version") else {
                        return Err(OneOf::new(Error::Generic));
                    };
                    self.out.version = if ver.eq_ignore_ascii_case(b"3.0") {
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
                                    Ok(_) => OneOf::new(Error::Manifest),
                                    Err(e) => e.broaden(),
                                },
                            })?;
                }
                // <spine>
                XmlEvent::Start(e) if e.local_name().as_ref() == b"spine" => {
                    let toc =
                        Self::get_attribute(&e, b"toc").map_err(|_| OneOf::new(Error::Generic))?;
                    self.out.spine.toc = toc.map(Id::from);
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
                    let value = e.unescape()?;
                    match last_value_pending_state.take().unwrap() {
                        LastValue::Metadata => metadata.last_mut().unwrap().value = value.into(),
                        LastValue::Refinement(id) => {
                            refinements.get_mut(&id).unwrap().last_mut().unwrap().value =
                                value.into();
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
                            id = Some(attr.value.into());
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
                        legacy: false,
                    });
                    last_value_pending_state = Some(LastValue::Metadata);
                }

                (Bound(Namespace(b"http://www.idpf.org/2007/opf")), XmlEvent::Start(e))
                    if e.local_name().as_ref() == b"meta" =>
                {
                    if let Some(property) = Self::get_attribute_decoded(&e, b"property", decoder)? {
                        let lang = Self::get_attribute_decoded(&e, b"xml:lang", decoder)?;

                        if let Some(refines) = Self::get_attribute(&e, b"refines")? {
                            // subexpression
                            let refines = refines.strip_prefix(b"#").unwrap_or_else(|| &refines);
                            let scheme = Self::get_attribute_decoded(&e, b"scheme", decoder)?;
                            let refinement = MetadataRefinement {
                                property,
                                value: String::new(), // tbd
                                lang,
                                scheme,
                            };
                            // push to refinements
                            if !refinements.contains_key(refines) {
                                refinements.insert(refines.into(), Vec::new());
                            }
                            refinements.get_mut(refines).unwrap().push(refinement);
                            last_value_pending_state = Some(LastValue::Refinement(refines.into()));
                        } else {
                            // primary expression
                            let id = Self::get_attribute(&e, b"id")?.map(Id::from);
                            metadata.push(MetadataItem {
                                id,
                                property,
                                value: String::new(), // tbd
                                lang,
                                refined: vec![],
                                legacy: false,
                            });
                            last_value_pending_state = Some(LastValue::Metadata);
                        }
                    }
                }

                (_, XmlEvent::Empty(e)) if e.local_name().as_ref() == b"meta" => {
                    // legacy XHTML1.1 <meta>
                    if let (Some(name), Some(content)) = (
                        Self::get_attribute_decoded(&e, b"name", decoder)?,
                        Self::get_attribute_decoded(&e, b"content", decoder)?,
                    ) {
                        metadata.push(MetadataItem {
                            id: None,
                            property: name,
                            value: content,
                            lang: None,
                            refined: vec![],
                            legacy: true,
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

    fn parse_manifest(&mut self) -> Result<Manifest, OneOf<(Error, url::ParseError, XmlError)>> {
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
                    let id = Self::get_attribute(&e, b"id").map_err(OneOf::new)?;
                    let id = id.ok_or(OneOf::new(Error::Manifest))?;
                    let href =
                        Self::get_attribute_decoded(&e, b"href", decoder).map_err(OneOf::new)?;
                    let href = href.ok_or(OneOf::new(Error::Manifest))?;
                    let media_type = Self::get_attribute_decoded(&e, b"media-type", decoder)
                        .map_err(OneOf::new)?;
                    let media_type = media_type.ok_or(OneOf::new(Error::Manifest))?;
                    let properties = Self::get_attribute_decoded(&e, b"properties", decoder)
                        .map_err(OneOf::new)?;
                    manifest.insert(
                        id.into(),
                        ResourceItem {
                            href,
                            media_type,
                            properties: properties.map(PropertiesValue),
                        },
                    );
                }

                _ => {}
            }
        }

        Ok(manifest)
    }

    fn parse_spine(&mut self) -> Result<Vec<Itemref>, OneOf<(Error, XmlError)>> {
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
                    let idref = Self::get_attribute(&e, b"idref").map_err(OneOf::new)?;
                    let idref = idref.ok_or(OneOf::new(Error::Spine))?;
                    let properties = Self::get_attribute_decoded(&e, b"properties", decoder)
                        .map_err(OneOf::new)?;
                    itemrefs.push(Itemref {
                        idref: idref.into(),
                        properties: properties.map(PropertiesValue),
                    });
                }

                _ => {}
            }
        }

        Ok(itemrefs)
    }

    fn get_attribute<'attr, N: AsRef<[u8]> + Sized>(
        start: &'attr quick_xml::events::BytesStart,
        name: N,
    ) -> Result<Option<Cow<'attr, [u8]>>, XmlError> {
        let attr = start.try_get_attribute(name)?;
        Ok(attr.map(|a| a.value))
    }

    fn get_attribute_decoded<'attr, N: AsRef<[u8]> + Sized>(
        start: &'attr quick_xml::events::BytesStart,
        name: N,
        decoder: quick_xml::Decoder,
    ) -> Result<Option<String>, XmlError> {
        match start.try_get_attribute(name)? {
            Some(a) => {
                let val = a.decode_and_unescape_value(decoder)?;
                Ok(Some(val.into()))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_package_version() {
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
        let package = Package::new(reader).expect("Failed parsing");
        assert_eq!(Version::Epub3_0, package.version);
    }

    #[test]
    fn test_parse_package_metadata() {
        let xml = include_bytes!("testing/metadata.opf");
        let package = Package::new(xml.as_slice()).expect("Failed parsing");
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
        let package = Package::new(reader).expect("Failed parsing");
        {
            let manifest = &package.manifest;
            assert_eq!(3, manifest.len());
            assert_eq!(
                ResourceItem {
                    href: "book.html".into(),
                    media_type: "application/xhtml+xml".into(),
                    properties: None
                },
                manifest[b"r4915".as_slice()]
            );
            assert_eq!(
                ResourceItem {
                    href: "images/cover.png".into(),
                    media_type: "image/png".into(),
                    properties: None
                },
                manifest[b"r7184".as_slice()]
            );
            assert_eq!(
                ResourceItem {
                    href: "nav.html".into(),
                    media_type: "application/xhtml+xml".into(),
                    properties: Some(PropertiesValue("nav".into())),
                },
                manifest[b"nav".as_slice()]
            );
        }
        {
            let spine = &package.spine;
            assert_eq!(None, spine.toc);
            assert_eq!(
                vec![Itemref {
                    idref: b"r4915".as_slice().into(),
                    properties: None
                },],
                spine.itemrefs
            );
        }
    }
}
