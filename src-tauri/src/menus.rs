// TODO:
// - Error handling
// - Put ID and Text in resource file that can be imported here and frontend.
// - Tidy the `use` or qualifiers

use tauri::{Emitter, menu::Menu};

use crate::prefs::FontPrefer;

fn handle_by_frontend<R>(app: &tauri::AppHandle<R>, id: &str)
where
    R: tauri::Runtime,
{
    if let Err(e) = app.emit_to("main", &format!("menu/{id}"), ()) {
        log::error!("Could not emit event to frontend: {}", e);
    }
}

pub mod file {
    use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};

    pub const ID: &str = "f";
    const TEXT: &str = "File";

    pub mod open {
        pub const ID: &str = "f_o";
        pub const TEXT: &str = "Open";
    }
    pub mod open_in_new_window {
        pub const ID: &str = "f_oinw";
        pub const TEXT: &str = "Open in new window";
    }

    pub mod show_in_folder {
        use tauri::Manager;
        use tauri_plugin_opener::OpenerExt;

        pub const ID: &str = "f_sif";
        pub const TEXT: &str = "Show in folder";

        pub fn handle(app: &tauri::AppHandle) {
            let state = app.state::<crate::AppState>();
            let state_guard = state.lock().unwrap();
            // TODO emit error to front end, and it can be used in lib.rs too
            let _ = app
                .opener()
                .reveal_item_in_dir(&state_guard.book_file_info.path);
        }
    }

    pub mod details {
        pub const ID: &str = "f_d";
        pub const TEXT: &str = "Details";
    }
    pub mod navigation {
        pub const ID: &str = "f_n";
        pub const TEXT: &str = "Navigation";
    }

    pub mod open_preference_file {
        use tauri_plugin_opener::OpenerExt;
        use tauri_plugin_store::resolve_store_path;

        pub const ID: &str = "f_opf";
        pub const TEXT: &str = "Open preference file";

        pub fn handle(app: &tauri::AppHandle) {
            if let Ok(path) = resolve_store_path(app, crate::PREFS_STORE) {
                let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
            }
        }
    }

    pub fn make<R>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>>
    where
        R: tauri::Runtime,
    {
        SubmenuBuilder::new(app, TEXT)
            .id(ID)
            .text(open::ID, open::TEXT)
            .text(open_preference_file::ID, open_preference_file::TEXT)
            .quit()
            .build()
    }

    pub fn update<R>(window: &tauri::Window<R>, submenu: &Submenu<R>) -> tauri::Result<()>
    where
        R: tauri::Runtime,
    {
        submenu.insert_items(
            &[
                &MenuItemBuilder::new(open_in_new_window::TEXT)
                    .id(open_in_new_window::ID)
                    .build(window)?,
                &PredefinedMenuItem::separator(window)?,
                &MenuItemBuilder::new(show_in_folder::TEXT)
                    .id(show_in_folder::ID)
                    .build(window)?,
                &MenuItemBuilder::new(details::TEXT)
                    .id(details::ID)
                    .build(window)?,
                &MenuItemBuilder::new(navigation::TEXT)
                    .id(navigation::ID)
                    .build(window)?,
                &PredefinedMenuItem::separator(window)?,
            ],
            1,
        )
    }
}

pub mod view {
    use tauri::menu::{Submenu, SubmenuBuilder};

    pub const ID: &str = "v";
    const TEXT: &str = "View";

    pub mod font_preference {
        use tauri::menu::{Submenu, SubmenuBuilder};
        use tauri_plugin_store::StoreExt;

        use crate::{menus::handle_by_frontend, prefs::FontPrefer};

        pub const ID: &str = "v_fp";
        const TEXT: &str = "Font preference";

        pub fn handle(app: &tauri::AppHandle, id: &str) {
            let Ok(prefs_store) = app.store(crate::PREFS_STORE) else {
                log::error!("Could not open preferences store");
                return;
            };

            // ensure at most one is checked
            let menu = app
                .menu()
                .unwrap()
                .get(crate::menus::view::ID)
                .unwrap()
                .as_submenu_unchecked()
                .get(ID)
                .unwrap();
            let menu = menu.as_submenu_unchecked();
            let menu_item = menu.get(id).unwrap();
            let menu_item = menu_item.as_check_menuitem_unchecked();
            let Ok(is_checked) = menu_item.is_checked() else {
                return;
            };
            let font_pref = if is_checked {
                Some(if id == serif::ID {
                    FontPrefer::Serif
                } else {
                    FontPrefer::SansSerif
                })
            } else {
                None
            };
            let _ = set(&menu, font_pref, &prefs_store);
        }

        pub mod sans_serif {
            pub const ID: &str = "v_fp_ss";
            pub(super) const TEXT: &str = "Sans-serif";
        }
        pub mod serif {
            pub const ID: &str = "v_fp_s";
            pub(super) const TEXT: &str = "Serif";
        }

        pub fn make<R, M>(manager: &M) -> tauri::Result<Submenu<R>>
        where
            R: tauri::Runtime,
            M: tauri::Manager<R>,
        {
            SubmenuBuilder::new(manager, TEXT)
                .id(ID)
                .check(sans_serif::ID, sans_serif::TEXT)
                .check(serif::ID, serif::TEXT)
                .build()
        }

        pub fn set<R>(
            submenu: &Submenu<R>,
            value: Option<FontPrefer>,
            prefs_store: &tauri_plugin_store::Store<R>,
        ) -> Result<(), tauri::Error>
        where
            R: tauri::Runtime,
        {
            let (sans_checked, serif_checked) = match value {
                Some(FontPrefer::SansSerif) => (true, false),
                Some(FontPrefer::Serif) => (false, true),
                None => (false, false),
            };
            submenu
                .get(sans_serif::ID)
                .unwrap()
                .as_check_menuitem_unchecked()
                .set_checked(sans_checked)?;
            submenu
                .get(serif::ID)
                .unwrap()
                .as_check_menuitem_unchecked()
                .set_checked(serif_checked)?;

            let json_value = match value {
                Some(FontPrefer::SansSerif) => serde_json::json!("sans-serif"),
                Some(FontPrefer::Serif) => serde_json::json!("serif"),
                None => serde_json::Value::Null,
            };
            // save prefs
            prefs_store.set("font.prefer", json_value.clone());

            // notify the front-end
            handle_by_frontend(submenu.app_handle(), ID);

            Ok(())
        }
    }

    pub mod open_filewise_styles {
        use tauri::Manager;
        use tauri_plugin_opener::OpenerExt;

        pub const ID: &str = "v_ofs";
        pub(super) const TEXT: &str = "Open filewise styles";

        pub fn handle(app: &tauri::AppHandle) {
            let state = app.state::<crate::AppState>();
            let Ok(css_path) = crate::custom_styles_path(app, &state.lock().unwrap()) else {
                return;
            };
            let _ = app
                .opener()
                .open_path(css_path.to_string_lossy(), None::<&str>);
        }
    }

    pub fn make<R>(window: &tauri::Window<R>) -> tauri::Result<Submenu<R>>
    where
        R: tauri::Runtime,
    {
        SubmenuBuilder::new(window, TEXT)
            .id(ID)
            .text(open_filewise_styles::ID, open_filewise_styles::TEXT)
            .separator()
            .item(&font_preference::make(window)?)
            .build()
    }
}

pub mod help {
    use tauri::menu::{Submenu, SubmenuBuilder};

    pub const ID: &str = "h";
    const TEXT: &str = "Help";

    pub mod version {
        pub const ID: &str = "h_v";
        pub(super) const TEXT: &str = "Version: 0.0.0";
    }

    pub mod website_support {
        use tauri_plugin_opener::OpenerExt;

        pub const ID: &str = "h_ws";
        pub(super) const TEXT: &str = "Website && Support";

        pub fn handle(app: &tauri::AppHandle) {
            let _ = app
                .opener()
                .open_url("https://ogier.lyfeng.xyz", None::<&str>);
        }
    }

    pub mod license_copyrights {
        use tauri::menu::{AboutMetadata, AboutMetadataBuilder};

        pub(super) const TEXT: &str = "License && Copyrights";
        const COMMENTS: &str = "Ogier: a fast and simple EPUB reader (freeware)";
        const COPYRIGHTS: &str = "Copyright 2025, Ogier EPUB Reader developers";

        pub(super) fn make_metadata<'a>() -> AboutMetadata<'a> {
            AboutMetadataBuilder::new()
                .comments(Some(COMMENTS))
                .copyright(Some(COPYRIGHTS))
                .build()
        }
    }

    pub fn make<R>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>>
    where
        R: tauri::Runtime,
    {
        SubmenuBuilder::new(app, TEXT)
            .id(ID)
            .text(version::ID, version::TEXT)
            .text(website_support::ID, website_support::TEXT)
            .about_with_text(
                license_copyrights::TEXT,
                Some(license_copyrights::make_metadata()),
            )
            .build()
    }
}

pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        file::open_in_new_window::ID => {
            log::debug!("Opening in new window is unimplemented");
        }
        file::show_in_folder::ID => file::show_in_folder::handle(app),
        file::open::ID | file::details::ID | file::navigation::ID => {
            handle_by_frontend(app, id);
        }

        file::open_preference_file::ID => file::open_preference_file::handle(app),

        view::font_preference::sans_serif::ID | view::font_preference::serif::ID => {
            view::font_preference::handle(app, id)
        }
        view::open_filewise_styles::ID => view::open_filewise_styles::handle(app),

        help::version::ID => (),
        help::website_support::ID => help::website_support::handle(app),

        _ => {
            log::warn!("Unexpected event {}", id);
        }
    }
}

pub fn make<R>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>>
where
    R: tauri::Runtime,
{
    let menu = Menu::new(app)?;
    let file_submenu = file::make(app)?;
    let help_submenu = help::make(app)?;
    menu.append_items(&[&file_submenu, &help_submenu])?;
    Ok(menu)
}

/// Returns true if updated. The function does nothing if the menu has been updated.
pub fn update<R>(
    window: &tauri::Window<R>,
    prefs_store: &tauri_plugin_store::Store<R>,
) -> Result<bool, tauri::Error>
where
    R: tauri::Runtime,
{
    let menu = window.menu().unwrap();
    if menu.get(view::ID).is_some() {
        return Ok(false);
    }

    // File
    let file_submenu = menu.get(file::ID).unwrap();
    file::update(window, file_submenu.as_submenu_unchecked())?;

    // View
    let view_submenu = view::make(window)?;
    menu.insert(&view_submenu, 1)?;

    // font prefer init value
    let font_prefer_value = prefs_store.get("font.prefer");
    set_font_preference(
        &window,
        match font_prefer_value {
            Some(serde_json::Value::String(value)) if value == "sans-serif" => {
                Some(FontPrefer::SansSerif)
            }
            Some(serde_json::Value::String(value)) if value == "serif" => Some(FontPrefer::Serif),
            _ => None,
        },
        prefs_store,
    )?;

    Ok(true)
}

fn set_font_preference<R>(
    window: &tauri::Window<R>,
    value: Option<FontPrefer>,
    prefs_store: &tauri_plugin_store::Store<R>,
) -> Result<(), tauri::Error>
where
    R: tauri::Runtime,
{
    let menu = window.menu().unwrap();
    let view = menu.get(view::ID).unwrap();
    let view = view.as_submenu_unchecked();
    let font_preference = view.get(view::font_preference::ID).unwrap();
    let font_preference = font_preference.as_submenu_unchecked();

    view::font_preference::set(font_preference, value, prefs_store)?;
    Ok(())
}
