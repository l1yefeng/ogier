use arrayvec::ArrayString;
use cssparser::{Delimiter, ParseError, Parser, ParserInput, ToCss, Token};

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

pub fn regulate_css(css: &str) -> Option<String> {
    println!("Regulating CSS: {}", css);
    let mut output = String::new();

    let mut input = ParserInput::new(css);
    let mut parser = Parser::new(&mut input);

    // FIXME: is is_exhausted() necessary?
    // FIXME: use a stack to keep track of nested blocks
    // FIXME: does identifier token need to be handled differently?
    while !parser.is_exhausted() {
        if let Err(_) = parser.parse_until_before(Delimiter::CurlyBracketBlock, |parser_pre_cb| {
            while let Ok(token) = parser_pre_cb.next_including_whitespace() {
                output.push_str(&token.to_css_string());
                match token {
                    Token::Function(_) | Token::ParenthesisBlock => {
                        parser_pre_cb.parse_nested_block(|parser_nested| {
                            while let Ok(token) = parser_nested.next_including_whitespace() {
                                output.push_str(&token.to_css_string());
                            }
                            Ok::<(), ParseError<'_, ()>>(())
                        })?;
                        output.push(')');
                    }
                    Token::SquareBracketBlock => {
                        parser_pre_cb.parse_nested_block(|parser_nested| {
                            while let Ok(token) = parser_nested.next_including_whitespace() {
                                output.push_str(&token.to_css_string());
                            }
                            Ok::<(), ParseError<'_, ()>>(())
                        })?;
                        output.push(']');
                    }
                    _ => {}
                }
            }
            Ok::<(), ParseError<'_, ()>>(())
        }) {
            return None;
        };
        if let Ok(_) = parser.expect_curly_bracket_block() {
            output.push('{');
            if let Err(_) = parser.parse_nested_block(|parser_in_cb| {
                let mut expect_line_height = false;
                while let Ok(token) = parser_in_cb.next_including_whitespace() {
                    match token {
                        Token::Semicolon => {
                            output.push(';');
                            // don't expect forever
                            expect_line_height = false;
                        }
                        Token::Percentage { unit_value, .. } if expect_line_height => {
                            output.push_str(&regulated_line_height(LineHeightValue::Percentage(
                                *unit_value,
                            )));
                        }
                        Token::Number { value, .. } if expect_line_height => {
                            output
                                .push_str(&regulated_line_height(LineHeightValue::Number(*value)));
                        }
                        Token::Dimension { int_value, .. } if int_value.is_some_and(|i| i == 0) => {
                            output.push_str("0");
                        }
                        Token::Dimension { value, unit, .. } if expect_line_height => {
                            output.push_str(&regulated_line_height(LineHeightValue::Length(
                                *value,
                                ArrayString::from(unit).unwrap_or_default(),
                            )));
                        }
                        Token::Dimension { value, unit, .. } => {
                            let s = match abs_length_in_rem(*value, unit) {
                                Some(rem) => format!("{rem:.2}rem"),
                                None => token.to_css_string(),
                            };
                            output.push_str(&s);
                        }
                        Token::Ident(ident)
                            if expect_line_height && ident.eq_ignore_ascii_case("normal") =>
                        {
                            output.push_str(&regulated_line_height(LineHeightValue::Normal));
                        }
                        Token::Ident(ident) => {
                            let s = match sml_in_rem(ident) {
                                Some(rem) => format!("{rem:.2}rem"),
                                None => token.to_css_string(),
                            };
                            output.push_str(&s);
                            if ident.eq_ignore_ascii_case("line-height") {
                                expect_line_height = true;
                            }
                        }
                        Token::Function(_) | Token::ParenthesisBlock => {
                            output.push_str(&token.to_css_string());
                            parser_in_cb.parse_nested_block(|parser_nested| {
                                while let Ok(token) = parser_nested.next_including_whitespace() {
                                    output.push_str(&token.to_css_string());
                                }
                                Ok::<(), ParseError<'_, ()>>(())
                            })?;
                            output.push(')');
                        }
                        Token::SquareBracketBlock => {
                            output.push_str(&token.to_css_string());
                            parser_in_cb.parse_nested_block(|parser_nested| {
                                while let Ok(token) = parser_nested.next_including_whitespace() {
                                    output.push_str(&token.to_css_string());
                                }
                                Ok::<(), ParseError<'_, ()>>(())
                            })?;
                            output.push(']');
                        }
                        _ => {
                            output.push_str(&token.to_css_string());
                        }
                    }
                }
                Ok::<(), ParseError<'_, ()>>(())
            }) {
                return None;
            }
            output.push('}');
        } else {
            break;
        }
    }

    Some(output)
}

#[cfg(test)]
mod tests {

    use crate::regulate_css;

    #[test]
    fn test_regulate_css_with_px_units() {
        let input =
            "body { font-size: 16px; margin: 32px; } p { padding: 8px; } a { font-size: medium; }";
        let expected =
            "body{font-size:1.00rem;margin:2.00rem;}p{padding:0.50rem;}a{font-size:1.00rem;}";
        assert_eq!(regulate_css(input), Some(String::from(expected)));
    }
}
