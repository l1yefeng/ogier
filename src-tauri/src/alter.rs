use arrayvec::ArrayString;
use cssparser::{ParseError, Parser, ParserInput, ToCss, Token};

use crate::prefs::FontSubstitute;

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
    font_substitute: &FontSubstitute,
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
                if let Some(subs) = font_substitute.get(&value.to_string()) {
                    output.push_str(subs);
                } else {
                    output.push_str(&token.to_css_string());
                }
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
                transform_css(parser_nested, output, false, false, font_substitute)
            })?;
            output.push(close);
        }
    }
    Ok(())
}

pub fn regulate_css(css: &str, font_substitute: &FontSubstitute) -> Option<String> {
    let mut output = String::new();

    let mut input = ParserInput::new(css);
    let mut parser = Parser::new(&mut input);

    if let Err(_) = transform_css(&mut parser, &mut output, false, false, font_substitute) {
        return None;
    }

    Some(output)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::regulate_css;

    #[test]
    fn test_regulate_css_font_size() {
        let input =
            "body { font-size: 16px; margin: 32px; } p { padding: 8px; } a { font-size: medium; }";
        let expected = "body { font-size: 1.00rem; margin: 2.00rem; } p { padding: 0.50rem; } a { font-size: 1.00rem; }";
        assert_eq!(regulate_css(input, &HashMap::new()).unwrap(), expected);
    }

    #[test]
    fn test_regulate_css_nesting() {
        let input = "body { color: green; p { color: red; a { color: blue } } }";
        let expected = "body { color: green; p { color: red; a { color: blue } } }";
        assert_eq!(regulate_css(input, &HashMap::new()).unwrap(), expected);
    }

    #[test]
    fn test_regulate_css_font_substitute() {
        let input = ":host { font-family: sans-serif } head {}";
        let expected = ":host { font-family: X } head {}";
        let map = HashMap::from_iter(vec![
            (String::from("sans-serif"), String::from("X")),
            (String::from("head"), String::from("Y")),
        ]);
        assert_eq!(regulate_css(input, &map).unwrap(), expected);
    }
}
