use std::collections::HashMap;

pub enum FontPrefer {
    SansSerif,
    Serif,
}

pub type FontSubstitute = HashMap<String, String>;
