// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, path::Path};

fn main() {
    let filepath = {
        match env::args_os().nth(1) {
            Some(arg) => {
                let path = Path::new(&arg);
                match path.canonicalize() {
                    Ok(path) => Some(path),
                    Err(err) => {
                        eprintln!("Invalid path {}: {}", arg.to_string_lossy(), err);
                        return;
                    }
                }
            }
            None => None,
        }
    };
    ogier_lib::run(filepath)
}
