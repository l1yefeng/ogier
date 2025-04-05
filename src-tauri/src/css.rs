use cssparser::{Delimiter, ParseError, Parser, ParserInput, ToCss, Token};

pub fn regulate_css(css: &str) -> Option<String> {
    println!("Regulating CSS: {}", css);
    let mut output = String::new();

    const BASE_FONT_SIZE: f32 = 16.0;

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
                while let Ok(token) = parser_in_cb.next_including_whitespace() {
                    match token {
                        Token::Dimension {
                            int_value, unit, ..
                        } if unit.eq_ignore_ascii_case("px")
                            && int_value.is_some_and(|i| i == 0) =>
                        {
                            output.push_str("0");
                        }
                        Token::Dimension { value, unit, .. } if unit.eq_ignore_ascii_case("px") => {
                            output.push_str(&format!("{:.2}rem", value / BASE_FONT_SIZE));
                        }
                        Token::Ident(ident) => {
                            if ident.eq_ignore_ascii_case("xx-small") {
                                output.push_str("0.60rem");
                            } else if ident.eq_ignore_ascii_case("x-small") {
                                output.push_str("0.75rem");
                            } else if ident.eq_ignore_ascii_case("small") {
                                output.push_str("0.89rem");
                            } else if ident.eq_ignore_ascii_case("medium") {
                                output.push_str("1.00rem");
                            } else if ident.eq_ignore_ascii_case("large") {
                                output.push_str("1.20rem");
                            } else if ident.eq_ignore_ascii_case("x-large") {
                                output.push_str("1.50rem");
                            } else if ident.eq_ignore_ascii_case("xx-large") {
                                output.push_str("2.00rem");
                            } else if ident.eq_ignore_ascii_case("xxx-large") {
                                output.push_str("3.00rem");
                            } else {
                                output.push_str(ident);
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
