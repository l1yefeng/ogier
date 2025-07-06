use std::io::{self, BufRead, BufReader, Read};

use arrayvec::ArrayString;
use cssparser::{ParseError, Parser, ParserInput, ToCss, Token};
use quick_xml::{
    Reader, Writer,
    events::{BytesText, Event, attributes::Attribute},
};

use crate::errors::AnyErr;

fn abs_length_in_rem(value: f32, unit: &str) -> Option<f32> {
    const BASE_FONT_SIZE: f32 = 16.0;
    match unit {
        "px" => Some(value / BASE_FONT_SIZE),
        "cm" => Some(value * 96.0 / 2.54 / BASE_FONT_SIZE), // 1cm = 96px / 2.54
        "mm" => Some(value * 96.0 / 2.54 / 10.0 / BASE_FONT_SIZE), // 1mm = 1cm / 10
        "Q" => Some(value * 96.0 / 25.4 / 40.0 / BASE_FONT_SIZE), // 1Q = 1cm / 40
        "in" => Some(value * 96.0 / BASE_FONT_SIZE),        // 1in = 96px
        "pc" => Some(value * 96.0 / 6.0 / BASE_FONT_SIZE),  // 1pc = 1in / 6
        "pt" => Some(value * 96.0 / 72.0 / BASE_FONT_SIZE), // 1pt = 1in / 72
        _ => None,
    }
}

fn sml_in_rem(ident: &str) -> Option<f32> {
    match ident {
        "xx-small" => Some(0.60),
        "x-small" => Some(0.75),
        "small" => Some(0.89),
        "medium" => Some(1.00),
        "large" => Some(1.20),
        "x-large" => Some(1.50),
        "xx-large" => Some(2.00),
        "xxx-large" => Some(3.00),
        _ => None,
    }
}

enum LineHeightValue {
    Normal,
    Number(f32),
    Length(f32, ArrayString<8>),
    Percentage(f32),
}

fn regulated_line_height(value: LineHeightValue) -> String {
    const SCALE_VAR: &str = "var(--og-line-height-scale)";
    match value {
        LineHeightValue::Normal => format!("calc({SCALE_VAR} * 1.25)"),
        LineHeightValue::Number(value) => format!("calc({SCALE_VAR} * {value:.2})"),
        LineHeightValue::Length(value, unit) => {
            // TODO: what about the other units?
            if unit.eq_ignore_ascii_case("em") {
                format!("calc({SCALE_VAR} * {value:.2})")
            } else {
                format!("{value:.2}{unit}")
            }
        }
        LineHeightValue::Percentage(value) => {
            // Assume that the auther intended to use a unitless number
            format!("calc({SCALE_VAR} * {value:.2})")
        }
    }
}

fn transform_css<'i>(
    parser: &mut Parser<'i, '_>,
    output: &mut String,
    mut expect_line_height: bool,
    mut expect_font_family: bool,
) -> Result<(), ParseError<'i, ()>> {
    while let Ok(token) = parser.next_including_whitespace() {
        match token {
            Token::Semicolon => {
                output.push(';');
                // don't expect forever
                expect_line_height = false;
                expect_font_family = false;
            }
            Token::Ident(ident) if ident.eq_ignore_ascii_case("line-height") => {
                output.push_str("line-height");
                expect_line_height = true;
            }
            Token::Ident(ident) if ident.eq_ignore_ascii_case("font-family") => {
                output.push_str("font-family");
                expect_font_family = true;
            }
            Token::Dimension { int_value, .. } if int_value.is_some_and(|i| i == 0) => {
                output.push('0');
            }
            // line height
            Token::Ident(ident) if expect_line_height && ident.eq_ignore_ascii_case("normal") => {
                output.push_str(&regulated_line_height(LineHeightValue::Normal));
            }
            Token::Percentage { unit_value, .. } if expect_line_height => {
                output.push_str(&regulated_line_height(LineHeightValue::Percentage(
                    *unit_value,
                )));
            }
            Token::Number { value, .. } if expect_line_height => {
                output.push_str(&regulated_line_height(LineHeightValue::Number(*value)));
            }
            Token::Dimension { value, unit, .. } if expect_line_height => {
                output.push_str(&regulated_line_height(LineHeightValue::Length(
                    *value,
                    ArrayString::from(unit).unwrap_or_default(),
                )));
            }
            // font size
            Token::Dimension { value, unit, .. } => {
                let s = match abs_length_in_rem(*value, unit) {
                    Some(rem) => format!("{rem:.2}rem"),
                    None => token.to_css_string(),
                };
                output.push_str(&s);
            }
            // font family
            Token::Ident(value) | Token::QuotedString(value) if expect_font_family => {
                output.push_str(&font_custom_property_ref(value));
                output.push_str(", ");
                output.push_str(&token.to_css_string());
            }
            Token::Ident(ident) => {
                let s = match sml_in_rem(ident) {
                    Some(rem) => format!("{rem:.2}rem"),
                    None => ident.to_string(),
                };
                output.push_str(&s);
            }
            _ => output.push_str(&token.to_css_string()),
        }
        let close = match token {
            Token::Function(_) | Token::ParenthesisBlock => Some(')'),
            Token::SquareBracketBlock => Some(']'),
            Token::CurlyBracketBlock => Some('}'),
            _ => None,
        };
        if let Some(close) = close {
            parser.parse_nested_block(|parser_nested| {
                transform_css(parser_nested, output, false, false)
            })?;
            output.push(close);
        }
    }
    Ok(())
}

fn font_custom_property_ref(name: &str) -> String {
    let mut out = String::from("var(--og-font-");
    for b in name.to_lowercase().as_bytes() {
        out.push_str(&format!("{:02x}", b));
    }
    out.push_str(")");
    out
}

fn alter_css_str(css: &str) -> Result<String, AnyErr> {
    let mut output = String::new();

    let mut input = ParserInput::new(css);
    let mut parser = Parser::new(&mut input);

    transform_css(&mut parser, &mut output, false, false).map_err(|_| AnyErr::EpubContent)?;

    Ok(output)
}

pub fn alter_css<R: Read>(mut reader: R) -> Result<Vec<u8>, AnyErr> {
    let mut css = String::new();
    reader.read_to_string(&mut css)?;
    alter_css_str(&css).map(Vec::from)
}

fn transform_xhtml<R: BufRead>(reader: R) -> Result<Vec<u8>, quick_xml::Error> {
    let mut reader = Reader::from_reader(reader);
    reader.config_mut().trim_text(false);

    let mut buffer = Vec::new();
    let mut writer = Writer::new(io::Cursor::new(Vec::new()));

    let mut is_css = false;
    loop {
        let evt = reader.read_event_into(&mut buffer)?;
        let mut replace = None;
        match evt {
            // done
            Event::Eof => return Ok(writer.into_inner().into_inner()),

            Event::Start(ref e) if e.name().as_ref() == b"style" => {
                is_css = true;
            }
            Event::Text(ref e) if is_css => {
                let css = e.unescape()?;
                let css = alter_css_str(&css).unwrap_or_else(|_| String::from(css));
                replace = Some(Event::Text(BytesText::from_escaped(css)));
            }
            Event::End(_) if is_css => {
                is_css = false;
            }

            Event::Start(ref e) => {
                if let Ok(Some(attr)) = e.try_get_attribute("style") {
                    let css = attr.decode_and_unescape_value(reader.decoder())?;
                    match alter_css_str(&css) {
                        Ok(css) => {
                            let mut start = e.to_owned();
                            start.clear_attributes();
                            e.attributes().for_each(|attr| {
                                if let Ok(attr) = attr {
                                    if attr.key.0.eq_ignore_ascii_case(b"style") {
                                        start.push_attribute(Attribute::from((
                                            "style",
                                            css.as_str(),
                                        )));
                                    } else {
                                        start.push_attribute(attr);
                                    }
                                }
                            });
                            replace = Some(Event::Start(start));
                        }
                        Err(_) => {}
                    }
                }
            }
            _ => {}
        }
        let _ = writer.write_event(replace.unwrap_or_else(|| evt.into_owned()));
    }
}

pub fn alter_xhtml<R: Read>(reader: R) -> Result<Vec<u8>, AnyErr> {
    transform_xhtml(BufReader::new(reader)).map_err(|_| AnyErr::EpubContent)
}

#[cfg(test)]
mod tests {
    use crate::{alter::alter_css_str, alter_xhtml};

    #[test]
    fn test_alter_css_font_size() {
        let input =
            "body { font-size: 16px; margin: 32px; } p { padding: 8px; } a { font-size: medium; }";
        let expected = "body { font-size: 1.00rem; margin: 2.00rem; } p { padding: 0.50rem; } a { font-size: 1.00rem; }";
        assert_eq!(expected, alter_css_str(input).unwrap());
    }

    #[test]
    fn test_alter_css_nesting() {
        let input = "body { color: green; p { color: red; a { color: blue } } }";
        let expected = "body { color: green; p { color: red; a { color: blue } } }";
        assert_eq!(expected, alter_css_str(input).unwrap());
    }

    #[test]
    fn test_alter_css_font_substitute() {
        let input = r#":host {
            font-family: "Noto Serif",
                serif;
        }
        head {}"#;
        let expected = r#":host {
            font-family: var(--og-font-6e6f746f207365726966), "Noto Serif",
                var(--og-font-7365726966), serif;
        }
        head {}"#;
        assert_eq!(expected, alter_css_str(input).unwrap());
    }

    #[test]
    fn test_alter_xhtml_style() {
        let input = r#"<html><head>
            <style>
                p {
                    color: blue;
                    line-height: 1;
                }
            </style>
        </head></html>"#;
        let expected = r#"<html><head>
            <style>
                p {
                    color: blue;
                    line-height: calc(var(--og-line-height-scale) * 1.00);
                }
            </style>
        </head></html>"#;
        let reader = input.as_bytes();
        assert_eq!(Vec::from(expected), alter_xhtml(reader).unwrap());
    }

    #[test]
    fn test_alter_xhtml_style_inline() {
        let input = "<html><body style=\"line-height:1\"></body></html>";
        let expected = "<html><body style=\"line-height:calc(var(--og-line-height-scale) * 1.00)\"></body></html>";
        let reader = input.as_bytes();
        assert_eq!(Vec::from(expected), alter_xhtml(reader).unwrap());
    }
}
